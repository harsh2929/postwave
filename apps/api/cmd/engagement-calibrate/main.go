// SPDX-License-Identifier: AGPL-3.0-only

// Command engagement-calibrate evaluates hash-verified F01 machine-positive
// and human-negative corpora against an exact published registry revision.
// It emits a content-free JSON receipt and uses distinct exit codes:
//
//	0  policy passed
//	1  operational failure
//	2  invalid invocation or evidence contract
//	3  policy failed
//	4  corpus was insufficient
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	engagement "github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

const (
	maxCalibrationCorpusPaths   = 32
	maxCalibrationEvidenceBytes = 256 << 20
)

type options struct {
	databaseURL     string
	registryVersion string
	corpusPaths     stringList
	persist         bool
	timeout         time.Duration
	policy          engagement.CalibrationPolicy
}

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }

func (values *stringList) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("value is empty")
	}
	*values = append(*values, value)
	return nil
}

type rateReceipt struct {
	Estimate *float64                       `json:"estimate,omitempty"`
	Interval *engagement.ConfidenceInterval `json:"interval,omitempty"`
}

type calibrationReceipt struct {
	SchemaVersion            string                              `json:"schema_version"`
	ID                       string                              `json:"id,omitempty"`
	Persisted                bool                                `json:"persisted"`
	Result                   string                              `json:"result"`
	ClassifierVersion        string                              `json:"classifier_version"`
	MethodologyVersion       string                              `json:"methodology_version"`
	RegistryVersion          string                              `json:"registry_version"`
	ConfigurationHash        string                              `json:"configuration_hash"`
	MachineCorpusHash        string                              `json:"machine_corpus_manifest_hash,omitempty"`
	HumanCorpusHash          string                              `json:"human_corpus_manifest_hash,omitempty"`
	CorrelatedCorpusHash     string                              `json:"correlated_human_corpus_manifest_hash,omitempty"`
	MachineCorpusHashes      []string                            `json:"machine_corpus_manifest_hashes"`
	HumanCorpusHashes        []string                            `json:"human_corpus_manifest_hashes"`
	CorrelatedCorpusHashes   []string                            `json:"correlated_human_corpus_manifest_hashes"`
	MachineSamples           int64                               `json:"machine_sample_count"`
	HumanSamples             int64                               `json:"human_sample_count"`
	ControlledSeedSamples    int64                               `json:"controlled_seed_sample_count"`
	ClassifiedSamples        int64                               `json:"classified_sample_count"`
	UnknownSamples           int64                               `json:"unknown_sample_count"`
	MachineRecall            rateReceipt                         `json:"machine_recall"`
	MachinePrecision         rateReceipt                         `json:"machine_precision"`
	FalseMachinePositiveRate rateReceipt                         `json:"false_machine_positive_rate"`
	HumanRecall              rateReceipt                         `json:"human_recall"`
	UnknownShare             rateReceipt                         `json:"unknown_share"`
	Policy                   engagement.CalibrationPolicy        `json:"policy"`
	Confusion                engagement.ConfusionMatrix          `json:"confusion_matrix"`
	PerSource                map[string]engagement.SourceMetrics `json:"per_source_metrics"`
	MethodologyNote          string                              `json:"methodology_note"`
	Fingerprint              string                              `json:"report_fingerprint"`
	RecordedAt               *time.Time                          `json:"recorded_at,omitempty"`
}

func main() {
	os.Exit(run(os.Args[1:], os.Getenv, os.Stdout, os.Stderr))
}

func run(args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	options, err := parseOptions(args, getenv, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return 0
	}
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-calibrate:", err)
		return 2
	}
	corpora, err := loadCalibrationCorpora(options.corpusPaths, maxCalibrationEvidenceBytes)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-calibrate: load corpus:", err)
		return 2
	}

	signalContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(signalContext, options.timeout)
	defer cancel()
	pool, err := db.New(ctx, options.databaseURL)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-calibrate: connect:", err)
		return 1
	}
	defer pool.Close()
	config := engagement.DefaultConfig()
	config.RegistryVersion = options.registryVersion
	report, err := engagement.RunCalibration(
		ctx,
		pool,
		engagement.CalibrationRunOptions{
			Config: config, Policy: options.policy, Persist: options.persist,
		},
		corpora...,
	)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-calibrate: evaluate:", err)
		if errors.Is(err, engagement.ErrInvalidInput) {
			return 2
		}
		return 1
	}
	if err := json.NewEncoder(stdout).Encode(receiptFromReport(report)); err != nil {
		_, _ = fmt.Fprintln(stderr, "engagement-calibrate: encode receipt:", err)
		return 1
	}
	return reportExitCode(report.Result)
}

func loadCalibrationCorpora(
	corpusPaths []string,
	maximumEvidenceBytes int64,
) ([]engagement.CalibrationCorpus, error) {
	if maximumEvidenceBytes <= 0 {
		return nil, fmt.Errorf("aggregate calibration evidence byte limit must be positive")
	}
	corpora := make([]engagement.CalibrationCorpus, 0, len(corpusPaths))
	remainingEvidenceBytes := maximumEvidenceBytes
	for index, corpusPath := range corpusPaths {
		corpus, err := engagement.LoadCalibrationCorpusDirectoryWithEvidenceLimit(
			corpusPath,
			remainingEvidenceBytes,
		)
		if err != nil {
			return nil, fmt.Errorf("corpus %d exceeds the remaining aggregate evidence byte limit of %d bytes: %w", index+1, remainingEvidenceBytes, err)
		}
		evidenceBytes := corpus.EvidenceBytes()
		if evidenceBytes <= 0 || evidenceBytes > remainingEvidenceBytes {
			return nil, fmt.Errorf("corpus %d reported invalid evidence size %d within remaining limit %d", index+1, evidenceBytes, remainingEvidenceBytes)
		}
		remainingEvidenceBytes -= evidenceBytes
		corpora = append(corpora, corpus)
	}
	return corpora, nil
}

func parseOptions(args []string, getenv func(string) string, output io.Writer) (options, error) {
	if getenv == nil {
		return options{}, fmt.Errorf("environment reader is required")
	}
	policy := engagement.DefaultCalibrationPolicy()
	parsed := options{
		registryVersion: engagement.CurrentRegistryV2,
		timeout:         2 * time.Minute,
		policy:          policy,
	}
	// Keep DATABASE_URL out of the FlagSet's default values. flag.PrintDefaults
	// includes string defaults verbatim, so registering the environment value
	// would disclose database credentials whenever an operator runs --help.
	databaseURLFlag := ""
	flags := flag.NewFlagSet("engagement-calibrate", flag.ContinueOnError)
	flags.SetOutput(output)
	flags.StringVar(&databaseURLFlag, "database-url", "", "postwave_app PostgreSQL URL (default DATABASE_URL)")
	flags.StringVar(&parsed.registryVersion, "registry-version", parsed.registryVersion, "exact immutable registry version")
	flags.Var(&parsed.corpusPaths, "corpus", "corpus directory containing manifest.json; repeat for each corpus")
	flags.BoolVar(&parsed.persist, "persist", false, "persist the hash-addressed append-only receipt")
	flags.DurationVar(&parsed.timeout, "timeout", parsed.timeout, "bounded total execution time")
	flags.IntVar(&parsed.policy.MinimumMachineSamples, "minimum-machine-samples", parsed.policy.MinimumMachineSamples, "minimum certifying machine examples")
	flags.IntVar(&parsed.policy.MinimumHumanSamples, "minimum-human-samples", parsed.policy.MinimumHumanSamples, "minimum labeled-human negative examples")
	flags.Float64Var(&parsed.policy.MinimumMachineRecall, "minimum-machine-recall", parsed.policy.MinimumMachineRecall, "minimum lower confidence bound for machine recall")
	flags.Float64Var(&parsed.policy.MinimumMachinePrecision, "minimum-machine-precision", parsed.policy.MinimumMachinePrecision, "minimum lower confidence bound for machine precision")
	flags.Float64Var(&parsed.policy.MaximumFalseMachinePositiveRate, "maximum-false-machine-positive-rate", parsed.policy.MaximumFalseMachinePositiveRate, "maximum upper confidence bound for false-machine-positive rate")
	flags.Float64Var(&parsed.policy.ConfidenceLevel, "confidence-level", parsed.policy.ConfidenceLevel, "two-sided Wilson score confidence level")
	flags.Float64Var(&parsed.policy.AssumedMachinePrevalence, "assumed-machine-prevalence", parsed.policy.AssumedMachinePrevalence, "deployment machine-event prevalence used for adjusted precision (required)")
	flags.StringVar(&parsed.policy.PrevalenceEvidenceManifestHash, "prevalence-evidence-sha256", parsed.policy.PrevalenceEvidenceManifestHash, "SHA-256 of the reviewed deployment-prevalence evidence manifest (required)")
	if err := flags.Parse(args); err != nil {
		return options{}, err
	}
	parsed.databaseURL = strings.TrimSpace(databaseURLFlag)
	if parsed.databaseURL == "" {
		parsed.databaseURL = strings.TrimSpace(getenv("DATABASE_URL"))
	}
	parsed.registryVersion = strings.ToLower(strings.TrimSpace(parsed.registryVersion))
	if parsed.databaseURL == "" {
		return options{}, fmt.Errorf("--database-url or DATABASE_URL is required")
	}
	if len(parsed.corpusPaths) == 0 {
		return options{}, fmt.Errorf("at least one --corpus is required")
	}
	// EvaluateCalibration has the same hard bound, but enforcing it here is
	// essential: every file corpus is an immutable in-memory snapshot, so the
	// command must reject an oversized invocation before loading any evidence.
	if len(parsed.corpusPaths) > maxCalibrationCorpusPaths {
		return options{}, fmt.Errorf("at most %d --corpus values are allowed", maxCalibrationCorpusPaths)
	}
	if flags.NArg() != 0 {
		return options{}, fmt.Errorf("unexpected positional arguments: %s", strings.Join(flags.Args(), " "))
	}
	if parsed.timeout < time.Second || parsed.timeout > 30*time.Minute {
		return options{}, fmt.Errorf("--timeout must be within 1s..30m")
	}
	parsed.policy.PrevalenceEvidenceManifestHash = strings.ToLower(strings.TrimSpace(parsed.policy.PrevalenceEvidenceManifestHash))
	if err := parsed.policy.Validate(); err != nil {
		return options{}, fmt.Errorf("calibration policy: %w", err)
	}
	return parsed, nil
}

func receiptFromReport(report engagement.CalibrationReport) calibrationReceipt {
	receipt := calibrationReceipt{
		SchemaVersion: report.ReportSchemaVersion,
		ID:            report.ID, Persisted: report.ID != "", Result: report.Result,
		ClassifierVersion:        report.ClassifierVersion,
		MethodologyVersion:       report.MethodologyVersion,
		RegistryVersion:          report.RegistryVersion,
		ConfigurationHash:        report.ConfigurationHash,
		MachineCorpusHash:        report.MachineCorpusManifestHash,
		HumanCorpusHash:          report.HumanCorpusManifestHash,
		CorrelatedCorpusHash:     report.CorrelatedCorpusManifestHash,
		MachineCorpusHashes:      cloneReceiptStrings(report.MachineCorpusManifestHashes),
		HumanCorpusHashes:        cloneReceiptStrings(report.HumanCorpusManifestHashes),
		CorrelatedCorpusHashes:   cloneReceiptStrings(report.CorrelatedCorpusManifestHashes),
		MachineSamples:           report.MachineSampleCount,
		HumanSamples:             report.HumanSampleCount,
		ControlledSeedSamples:    report.ControlledSeedSampleCount,
		ClassifiedSamples:        report.ClassifiedSampleCount,
		UnknownSamples:           report.UnknownSampleCount,
		MachineRecall:            rateReceipt{Estimate: report.MachineRecall, Interval: report.MachineRecallInterval},
		MachinePrecision:         rateReceipt{Estimate: report.MachinePrecision, Interval: report.MachinePrecisionInterval},
		FalseMachinePositiveRate: rateReceipt{Estimate: report.FalseMachinePositiveRate, Interval: report.FalsePositiveRateInterval},
		HumanRecall:              rateReceipt{Estimate: report.HumanRecall, Interval: report.HumanRecallInterval},
		UnknownShare:             rateReceipt{Estimate: &report.UnknownShare, Interval: report.UnknownShareInterval},
		Policy:                   report.Policy, Confusion: report.Confusion,
		PerSource: report.PerSource, MethodologyNote: report.MethodologyNote,
		Fingerprint: report.Fingerprint,
	}
	if !report.RecordedAt.IsZero() {
		recordedAt := report.RecordedAt.UTC()
		receipt.RecordedAt = &recordedAt
	}
	return receipt
}

func cloneReceiptStrings(values []string) []string {
	cloned := make([]string, len(values))
	copy(cloned, values)
	return cloned
}

func reportExitCode(result string) int {
	switch result {
	case "pass":
		return 0
	case "fail":
		return 3
	case "insufficient_corpus":
		return 4
	default:
		return 1
	}
}
