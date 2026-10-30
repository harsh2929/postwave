// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	engagement "github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/stretchr/testify/require"
)

func TestParseOptionsUsesEnvironmentAndRepeatedCorpora(t *testing.T) {
	environment := func(key string) string {
		if key == "DATABASE_URL" {
			return "  postgresql://postwave_app@/postwave  "
		}
		return ""
	}

	parsed, err := parseOptions([]string{
		"--corpus", " ./machine ",
		"--corpus=./human",
		"--persist",
		"--timeout", "45s",
		"--minimum-machine-samples", "1200",
		"--minimum-human-samples", "1300",
		"--minimum-machine-recall", "0.96",
		"--minimum-machine-precision", "0.995",
		"--maximum-false-machine-positive-rate", "0.005",
		"--confidence-level", "0.99",
		"--assumed-machine-prevalence", "0.08",
		"--prevalence-evidence-sha256", strings.Repeat("A", 64),
	}, environment, io.Discard)
	require.NoError(t, err)
	require.Equal(t, "postgresql://postwave_app@/postwave", parsed.databaseURL)
	require.Equal(t, engagement.CurrentRegistryV2, parsed.registryVersion)
	require.Equal(t, stringList{"./machine", "./human"}, parsed.corpusPaths)
	require.True(t, parsed.persist)
	require.Equal(t, 45*time.Second, parsed.timeout)
	require.Equal(t, engagement.CalibrationPolicy{
		MinimumMachineSamples:           1200,
		MinimumHumanSamples:             1300,
		MinimumMachineRecall:            0.96,
		MinimumMachinePrecision:         0.995,
		MaximumFalseMachinePositiveRate: 0.005,
		ConfidenceLevel:                 0.99,
		AssumedMachinePrevalence:        0.08,
		PrevalenceEvidenceManifestHash:  strings.Repeat("a", 64),
	}, parsed.policy)
}

func TestParseOptionsRejectsUnsafeOrAmbiguousInvocation(t *testing.T) {
	tests := []struct {
		name string
		args []string
		env  string
		want string
	}{
		{name: "database missing", args: []string{"--corpus", "./machine"}, want: "database-url"},
		{name: "corpus missing", env: "postgresql://postwave_app@/postwave", want: "at least one --corpus"},
		{name: "empty corpus", env: "postgresql://postwave_app@/postwave", args: []string{"--corpus", "  "}, want: "value is empty"},
		{name: "positional argument", env: "postgresql://postwave_app@/postwave", args: []string{"--corpus", "./machine", "extra"}, want: "unexpected positional"},
		{name: "timeout too short", env: "postgresql://postwave_app@/postwave", args: []string{"--corpus", "./machine", "--timeout", "999ms"}, want: "1s..30m"},
		{name: "timeout too long", env: "postgresql://postwave_app@/postwave", args: []string{"--corpus", "./machine", "--timeout", "31m"}, want: "1s..30m"},
		{name: "prevalence missing", env: "postgresql://postwave_app@/postwave", args: []string{"--corpus", "./machine"}, want: "calibration policy"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseOptions(test.args, func(key string) string {
				if key == "DATABASE_URL" {
					return test.env
				}
				return ""
			}, io.Discard)
			require.ErrorContains(t, err, test.want)
		})
	}
	manyCorpora := []string{
		"--database-url", "postgresql://postwave_app@/postwave",
		"--assumed-machine-prevalence", "0.5",
		"--prevalence-evidence-sha256", strings.Repeat("a", 64),
	}
	for index := 0; index <= maxCalibrationCorpusPaths; index++ {
		manyCorpora = append(manyCorpora, "--corpus", fmt.Sprintf("./corpus-%d", index))
	}
	_, err := parseOptions(manyCorpora, func(string) string { return "" }, io.Discard)
	require.ErrorContains(t, err, "at most 32 --corpus")

	var help bytes.Buffer
	_, err = parseOptions([]string{"--help"}, func(key string) string {
		if key == "DATABASE_URL" {
			return "postgresql://postwave_app:secret-must-not-leak@localhost/postwave"
		}
		return ""
	}, &help)
	require.ErrorIs(t, err, flag.ErrHelp)
	require.Contains(t, help.String(), "default DATABASE_URL")
	require.NotContains(t, help.String(), "secret-must-not-leak")
	_, err = parseOptions(nil, nil, io.Discard)
	require.ErrorContains(t, err, "environment reader is required")
}

func TestReceiptFromReportIsContentFreeAndPreservesProvenance(t *testing.T) {
	estimate := 0.987654
	interval := &engagement.ConfidenceInterval{Lower: 0.97, Upper: 0.995, ConfidenceLevel: 0.95}
	recordedAt := time.Date(2026, 8, 13, 9, 30, 0, 0, time.FixedZone("IST", 5*60*60+30*60))
	report := engagement.CalibrationReport{
		ReportSchemaVersion:          engagement.CalibrationReportV2,
		ID:                           "018f68f5-bdc8-7f7b-8a20-c82b6b9de372",
		ClassifierVersion:            "postwave.engagement-classifier.v2",
		MethodologyVersion:           "postwave.engagement-methodology.v2",
		RegistryVersion:              engagement.CurrentRegistryV2,
		ConfigurationHash:            strings.Repeat("a", 64),
		MachineCorpusManifestHash:    strings.Repeat("b", 64),
		HumanCorpusManifestHash:      strings.Repeat("c", 64),
		CorrelatedCorpusManifestHash: strings.Repeat("e", 64),
		MachineCorpusManifestHashes:  []string{strings.Repeat("b", 64), strings.Repeat("f", 64)},
		HumanCorpusManifestHashes:    []string{strings.Repeat("c", 64)},
		CorrelatedCorpusManifestHashes: []string{
			strings.Repeat("e", 64),
		},
		MachineSampleCount:        1000,
		HumanSampleCount:          1000,
		ControlledSeedSampleCount: 37,
		ClassifiedSampleCount:     1995,
		UnknownSampleCount:        5,
		MachineRecall:             &estimate,
		MachineRecallInterval:     interval,
		UnknownShare:              0.0025,
		UnknownShareInterval:      &engagement.ConfidenceInterval{Lower: 0.001, Upper: 0.006, ConfidenceLevel: 0.95},
		Policy: func() engagement.CalibrationPolicy {
			policy := engagement.DefaultCalibrationPolicy()
			policy.AssumedMachinePrevalence = 0.08
			policy.PrevalenceEvidenceManifestHash = strings.Repeat("e", 64)
			return policy
		}(),
		Confusion:       engagement.ConfusionMatrix{MachineAsMachine: 988},
		PerSource:       map[string]engagement.SourceMetrics{"gmail": {Samples: 2000}},
		Result:          "pass",
		MethodologyNote: "bounded methodology note",
		Fingerprint:     strings.Repeat("d", 64),
		RecordedAt:      recordedAt,
	}

	receipt := receiptFromReport(report)
	require.True(t, receipt.Persisted)
	require.NotNil(t, receipt.RecordedAt)
	require.Equal(t, recordedAt.UTC(), *receipt.RecordedAt)
	require.Equal(t, &estimate, receipt.MachineRecall.Estimate)
	require.Same(t, interval, receipt.MachineRecall.Interval)
	require.Equal(t, report.CorrelatedCorpusManifestHash, receipt.CorrelatedCorpusHash)
	require.Equal(t, report.MachineCorpusManifestHashes, receipt.MachineCorpusHashes)
	require.Equal(t, report.HumanCorpusManifestHashes, receipt.HumanCorpusHashes)
	require.Equal(t, report.CorrelatedCorpusManifestHashes, receipt.CorrelatedCorpusHashes)
	require.Equal(t, int64(37), receipt.ControlledSeedSamples)
	require.NotNil(t, receipt.UnknownShare.Estimate)
	require.Equal(t, 0.0025, *receipt.UnknownShare.Estimate)

	raw, err := json.Marshal(receipt)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "recipient@example")
	require.NotContains(t, string(raw), "raw_email")
	require.Contains(t, string(raw), report.Fingerprint)
	require.Contains(t, string(raw), `"controlled_seed_sample_count":37`)
	require.Contains(t, string(raw), `"machine_corpus_manifest_hashes"`)
	require.Contains(t, string(raw), `"human_corpus_manifest_hashes"`)
	require.Contains(t, string(raw), `"correlated_human_corpus_manifest_hashes"`)

	receipt.MachineCorpusHashes[0] = strings.Repeat("0", 64)
	require.Equal(t, strings.Repeat("b", 64), report.MachineCorpusManifestHashes[0])

	unpersisted := report
	unpersisted.ID = ""
	unpersisted.RecordedAt = time.Time{}
	unpersistedReceipt := receiptFromReport(unpersisted)
	require.False(t, unpersistedReceipt.Persisted)
	require.Nil(t, unpersistedReceipt.RecordedAt)
}

func TestRunReturnsContractExitCodesBeforeDatabaseAccess(t *testing.T) {
	t.Run("invalid invocation", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := run(nil, func(string) string { return "" }, &stdout, &stderr)
		require.Equal(t, 2, code)
		require.Empty(t, stdout.String())
		require.Contains(t, stderr.String(), "database-url")
	})

	t.Run("invalid corpus", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		code := run([]string{
			"--database-url", "postgresql://postwave_app@/unused",
			"--corpus", t.TempDir(),
			"--assumed-machine-prevalence", "0.5",
			"--prevalence-evidence-sha256", strings.Repeat("a", 64),
		}, func(string) string { return "" }, &stdout, &stderr)
		require.Equal(t, 2, code)
		require.Empty(t, stdout.String())
		require.Contains(t, stderr.String(), "load corpus")
		require.NotContains(t, stderr.String(), "postgresql://")
	})

	t.Run("database parse error is redacted", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		secret := "calibration-password-must-not-leak"
		code := run([]string{
			"--database-url", "postgresql://postwave_app:" + secret + "@%gh&%ij/postwave",
			"--corpus", writeEmptyCalibrationCorpus(t),
			"--assumed-machine-prevalence", "0.5",
			"--prevalence-evidence-sha256", strings.Repeat("a", 64),
		}, func(string) string { return "" }, &stdout, &stderr)
		require.Equal(t, 1, code)
		require.Empty(t, stdout.String())
		require.Contains(t, stderr.String(), "connect")
		require.NotContains(t, stderr.String(), secret)
	})
}

func TestRunEvaluatesVerifiedCorporaAgainstRestrictedDatabase(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("POSTWAVE_ENGAGEMENT_CLASSIFIER_APP_TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("POSTWAVE_ENGAGEMENT_CLASSIFIER_APP_TEST_DATABASE_URL is required for calibration CLI PostgreSQL proof")
	}
	deliveredAt := time.Date(2026, 8, 13, 8, 0, 0, 0, time.UTC)
	humanDwell := int64(30_000)
	machine := engagement.CalibrationExampleV2{
		ID: "machine-cli-1", SamplingUnitHash: cliSamplingUnitHash("machine-cli-1"), GroundTruth: engagement.Machine,
		Source: "gmail", EventType: "opened", OccurredAt: deliveredAt.Add(time.Second),
		DeliveredAt: &deliveredAt, UserAgent: "Mozilla/5.0 (compatible; GoogleImageProxy)",
	}
	human := engagement.CalibrationExampleV2{
		ID: "human-cli-1", SamplingUnitHash: cliSamplingUnitHash("human-cli-1"), GroundTruth: engagement.Human,
		Source: "gmail", EventType: "opened", OccurredAt: deliveredAt.Add(time.Minute),
		DeliveredAt: &deliveredAt, DwellMilliseconds: &humanDwell,
	}
	machineDirectory := writeCalibrationCorpus(t, "machine-cli", engagement.ControlledMachineCorpus, machine)
	humanDirectory := writeCalibrationCorpus(t, "human-cli", engagement.LabeledHumanCorpus, human)

	var stdout, stderr bytes.Buffer
	code := run([]string{
		"--database-url", databaseURL,
		"--corpus", machineDirectory,
		"--corpus", humanDirectory,
		"--minimum-machine-samples", "1",
		"--minimum-human-samples", "1",
		"--minimum-machine-recall", "0",
		"--minimum-machine-precision", "0",
		"--maximum-false-machine-positive-rate", "1",
		"--assumed-machine-prevalence", "0.5",
		"--prevalence-evidence-sha256", strings.Repeat("a", 64),
	}, func(string) string { return "" }, &stdout, &stderr)
	require.Equal(t, 0, code, stderr.String())
	require.Empty(t, stderr.String())

	var receipt calibrationReceipt
	require.NoError(t, json.NewDecoder(&stdout).Decode(&receipt))
	require.Equal(t, engagement.CalibrationReportV2, receipt.SchemaVersion)
	require.Equal(t, "pass", receipt.Result)
	require.False(t, receipt.Persisted)
	require.Empty(t, receipt.ID)
	require.Equal(t, int64(1), receipt.MachineSamples)
	require.Equal(t, int64(1), receipt.HumanSamples)
	require.NotEmpty(t, receipt.MachineCorpusHash)
	require.NotEmpty(t, receipt.HumanCorpusHash)
	require.Empty(t, receipt.CorrelatedCorpusHash)
	require.NotEmpty(t, receipt.Fingerprint)
}

func TestLoadCalibrationCorporaRejectsCumulativeEvidenceOverBudget(t *testing.T) {
	firstDirectory := writeCalibrationCorpus(t, "machine-budget", engagement.ControlledMachineCorpus,
		engagement.CalibrationExampleV2{
			ID: "machine-budget", SamplingUnitHash: cliSamplingUnitHash("machine-budget"),
			GroundTruth: engagement.Machine, Source: "gmail", EventType: "opened", OccurredAt: time.Now().UTC(),
		})
	secondDirectory := writeCalibrationCorpus(t, "human-budget", engagement.LabeledHumanCorpus,
		engagement.CalibrationExampleV2{
			ID: "human-budget", SamplingUnitHash: cliSamplingUnitHash("human-budget"),
			GroundTruth: engagement.Human, Source: "gmail", EventType: "opened", OccurredAt: time.Now().UTC(),
		})
	first, err := engagement.LoadCalibrationCorpusDirectory(firstDirectory)
	require.NoError(t, err)
	second, err := engagement.LoadCalibrationCorpusDirectory(secondDirectory)
	require.NoError(t, err)
	exactAggregateBytes := first.EvidenceBytes() + second.EvidenceBytes()

	corpora, err := loadCalibrationCorpora(
		[]string{firstDirectory, secondDirectory},
		exactAggregateBytes-1,
	)
	require.ErrorContains(t, err, "remaining aggregate evidence byte limit")
	require.Nil(t, corpora)

	corpora, err = loadCalibrationCorpora(
		[]string{firstDirectory, secondDirectory},
		exactAggregateBytes,
	)
	require.NoError(t, err)
	require.Len(t, corpora, 2)
	_, err = loadCalibrationCorpora([]string{firstDirectory}, 0)
	require.ErrorContains(t, err, "must be positive")
}

func TestReportExitCode(t *testing.T) {
	require.Equal(t, 0, reportExitCode("pass"))
	require.Equal(t, 3, reportExitCode("fail"))
	require.Equal(t, 4, reportExitCode("insufficient_corpus"))
	require.Equal(t, 1, reportExitCode("unexpected"))
}

func writeEmptyCalibrationCorpus(t *testing.T) string {
	t.Helper()
	return writeCalibrationCorpus(t, "empty-controlled-machine", engagement.ControlledMachineCorpus)
}

func writeCalibrationCorpus(
	t *testing.T,
	name string,
	kind engagement.CorpusKind,
	examples ...engagement.CalibrationExampleV2,
) string {
	t.Helper()
	directory := t.TempDir()
	var examplesBytes bytes.Buffer
	for _, example := range examples {
		raw, err := json.Marshal(example)
		require.NoError(t, err)
		examplesBytes.Write(raw)
		examplesBytes.WriteByte('\n')
	}
	digest := sha256.Sum256(examplesBytes.Bytes())
	manifest := engagement.CalibrationCorpusManifestV2{
		ContractVersion: engagement.CalibrationCorpusContractV2,
		Name:            name,
		Kind:            kind,
		Version:         "corpus.v1",
		Provider:        "gmail",
		SamplingUnit:    "message_recipient",
		SampleCount:     len(examples),
		ExamplesFile:    "examples.jsonl",
		ExamplesSHA256:  fmt.Sprintf("%x", digest),
	}
	raw, err := json.Marshal(manifest)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(directory, "manifest.json"), raw, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(directory, manifest.ExamplesFile), examplesBytes.Bytes(), 0o600))
	return directory
}

func cliSamplingUnitHash(id string) string {
	digest := sha256.Sum256([]byte("postwave.test.cli-calibration-sampling-unit.v1\x00" + id))
	return fmt.Sprintf("%x", digest)
}
