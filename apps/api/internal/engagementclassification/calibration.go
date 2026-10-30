// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type CorpusKind string

const (
	ControlledMachineCorpus CorpusKind = "controlled_machine"
	LabeledHumanCorpus      CorpusKind = "labeled_human"
	CorrelatedHumanCorpus   CorpusKind = "correlated_human"
	CalibrationReportV2                = "postwave.engagement-calibration-report.v2"
)

type CorpusManifest struct {
	Name         string
	Kind         CorpusKind
	Version      string
	ManifestHash string
	Provider     string
	// SamplingUnit names the governed unit represented by one example (for
	// example, "message_recipient" or "scanner_run"). Every example must also
	// carry a globally stable SamplingUnitHash. Evaluation rejects duplicates
	// across all supplied corpora so Wilson intervals are never silently based
	// on repeated rows from the same declared unit.
	SamplingUnit string
	SampleCount  int
}

type LabeledExample struct {
	ID               string
	Provider         string
	SamplingUnitHash string
	GroundTruth      Classification
	Observation      ObservationInput
	Aggregate        MessageAggregate
}

// CalibrationCorpus streams labeled examples without constraining storage.
// Seed-fleet implementations use ControlledMachineCorpus; a distinct labeled
// human/negative corpus is required before precision can be computed.
type CalibrationCorpus interface {
	Manifest(ctx context.Context) (CorpusManifest, error)
	ForEach(ctx context.Context, visit func(LabeledExample) error) error
}

type CalibrationPolicy struct {
	MinimumMachineSamples           int     `json:"minimum_machine_samples"`
	MinimumHumanSamples             int     `json:"minimum_human_samples"`
	MinimumMachineRecall            float64 `json:"minimum_machine_recall"`
	MinimumMachinePrecision         float64 `json:"minimum_machine_precision"`
	MaximumFalseMachinePositiveRate float64 `json:"maximum_false_machine_positive_rate"`
	ConfidenceLevel                 float64 `json:"confidence_level"`
	AssumedMachinePrevalence        float64 `json:"assumed_machine_prevalence"`
	PrevalenceEvidenceManifestHash  string  `json:"prevalence_evidence_manifest_hash"`
}

func DefaultCalibrationPolicy() CalibrationPolicy {
	return CalibrationPolicy{
		MinimumMachineSamples:           1000,
		MinimumHumanSamples:             1000,
		MinimumMachineRecall:            0.95,
		MinimumMachinePrecision:         0.99,
		MaximumFalseMachinePositiveRate: 0.01,
		ConfidenceLevel:                 0.95,
		// Precision (positive predictive value) cannot be inferred from a
		// case-control corpus mix. Callers must explicitly bind these two
		// fields to a reviewed deployment-population manifest before use.
		AssumedMachinePrevalence:       0,
		PrevalenceEvidenceManifestHash: "",
	}
}

func (policy CalibrationPolicy) Validate() error {
	return validateCalibrationPolicy(policy)
}

// ConfidenceInterval is a two-sided Wilson score interval. Calibration gates
// use the conservative bound, never the point estimate: lower for recall and
// precision, upper for the false-machine-positive rate.
type ConfidenceInterval struct {
	Lower           float64 `json:"lower"`
	Upper           float64 `json:"upper"`
	ConfidenceLevel float64 `json:"confidence_level"`
}

type ConfusionMatrix struct {
	MachineAsMachine int64 `json:"machine_as_machine"`
	MachineAsHuman   int64 `json:"machine_as_human"`
	MachineAsUnknown int64 `json:"machine_as_unknown"`
	HumanAsHuman     int64 `json:"human_as_human"`
	HumanAsMachine   int64 `json:"human_as_machine"`
	HumanAsUnknown   int64 `json:"human_as_unknown"`
}

type SourceMetrics struct {
	Samples               int64           `json:"samples"`
	CertifyingSamples     int64           `json:"certifying_samples"`
	DiagnosticSamples     int64           `json:"diagnostic_samples"`
	ControlledSeedSamples int64           `json:"controlled_seed_samples"`
	MachineTruth          int64           `json:"machine_truth"`
	HumanTruth            int64           `json:"human_truth"`
	Human                 int64           `json:"human"`
	Machine               int64           `json:"machine"`
	Unknown               int64           `json:"unknown"`
	CertifyingConfusion   ConfusionMatrix `json:"certifying_confusion"`
	DiagnosticConfusion   ConfusionMatrix `json:"diagnostic_confusion"`
}

type CalibrationReport struct {
	ReportSchemaVersion            string                   `json:"report_schema_version"`
	ID                             string                   `json:"id,omitempty"`
	ClassifierVersion              string                   `json:"classifier_version"`
	MethodologyVersion             string                   `json:"methodology_version"`
	RegistryVersion                string                   `json:"registry_version"`
	ConfigurationHash              string                   `json:"configuration_hash"`
	MachineCorpusManifestHash      string                   `json:"machine_corpus_manifest_hash,omitempty"`
	HumanCorpusManifestHash        string                   `json:"human_corpus_manifest_hash,omitempty"`
	CorrelatedCorpusManifestHash   string                   `json:"correlated_human_corpus_manifest_hash,omitempty"`
	MachineCorpusManifestHashes    []string                 `json:"machine_corpus_manifest_hashes,omitempty"`
	HumanCorpusManifestHashes      []string                 `json:"human_corpus_manifest_hashes,omitempty"`
	CorrelatedCorpusManifestHashes []string                 `json:"correlated_human_corpus_manifest_hashes,omitempty"`
	MachineSampleCount             int64                    `json:"machine_sample_count"`
	HumanSampleCount               int64                    `json:"human_sample_count"`
	ControlledSeedSampleCount      int64                    `json:"controlled_seed_sample_count"`
	ClassifiedSampleCount          int64                    `json:"classified_sample_count"`
	UnknownSampleCount             int64                    `json:"unknown_sample_count"`
	MachineRecall                  *float64                 `json:"machine_recall,omitempty"`
	MachinePrecision               *float64                 `json:"machine_precision,omitempty"`
	FalseMachinePositiveRate       *float64                 `json:"false_machine_positive_rate,omitempty"`
	HumanRecall                    *float64                 `json:"human_recall,omitempty"`
	UnknownShare                   float64                  `json:"unknown_share"`
	MachineRecallInterval          *ConfidenceInterval      `json:"machine_recall_interval,omitempty"`
	MachinePrecisionInterval       *ConfidenceInterval      `json:"machine_precision_interval,omitempty"`
	FalsePositiveRateInterval      *ConfidenceInterval      `json:"false_machine_positive_rate_interval,omitempty"`
	HumanRecallInterval            *ConfidenceInterval      `json:"human_recall_interval,omitempty"`
	UnknownShareInterval           *ConfidenceInterval      `json:"unknown_share_interval,omitempty"`
	Policy                         CalibrationPolicy        `json:"policy"`
	Confusion                      ConfusionMatrix          `json:"confusion_matrix"`
	PerSource                      map[string]SourceMetrics `json:"per_source_metrics"`
	Result                         string                   `json:"result"`
	MethodologyNote                string                   `json:"methodology_note"`
	Fingerprint                    string                   `json:"report_fingerprint,omitempty"`
	RecordedAt                     time.Time                `json:"recorded_at,omitempty"`
}

func EvaluateCalibration(
	ctx context.Context,
	classifier *Classifier,
	policy CalibrationPolicy,
	corpora ...CalibrationCorpus,
) (CalibrationReport, error) {
	if classifier == nil || len(corpora) == 0 {
		return CalibrationReport{}, fmt.Errorf("%w: classifier and corpora are required", ErrInvalidInput)
	}
	if len(corpora) > maxCalibrationCorpora {
		return CalibrationReport{}, fmt.Errorf("%w: calibration evaluation exceeds %d corpora", ErrInvalidInput, maxCalibrationCorpora)
	}
	if err := validateCalibrationPolicy(policy); err != nil {
		return CalibrationReport{}, err
	}
	report := CalibrationReport{
		ReportSchemaVersion: CalibrationReportV2,
		ClassifierVersion:   classifier.config.ClassifierVersion,
		MethodologyVersion:  classifier.config.MethodologyVersion,
		RegistryVersion:     classifier.config.RegistryVersion,
		ConfigurationHash:   classifier.configHash,
		PerSource:           map[string]SourceMetrics{},
		Policy:              policy,
		MethodologyNote: fmt.Sprintf(
			"One distinct governed sampling-unit hash is required per example and duplicates across all supplied corpora are rejected. Non-seed controlled-machine examples estimate machine recall and a separate labeled-human negative corpus estimates false-machine-positive rate. Controlled-seed examples are diagnostic only because seed identity is an absolute classifier input and cannot certify recall without circularity. Machine precision is prevalence-adjusted positive predictive value at the explicitly declared deployment machine prevalence %.6f from evidence manifest %s; it is never the case-control sample-mix precision. Recall and false-positive thresholds use two-sided Wilson bounds at %.3f confidence. The precision bound uses Bonferroni-adjusted component Wilson bounds for at least the declared joint confidence. Correlated-human examples are diagnostic only.",
			policy.AssumedMachinePrevalence,
			policy.PrevalenceEvidenceManifestHash,
			policy.ConfidenceLevel,
		),
	}
	machineManifestHashes := make([]string, 0)
	humanManifestHashes := make([]string, 0)
	correlatedManifestHashes := make([]string, 0)
	seenManifestHashes := make(map[string]struct{}, len(corpora))
	run := &calibrationRun{
		classifier:             classifier,
		report:                 &report,
		seenSamplingUnitHashes: make(map[string]struct{}),
	}
	declaredSamples := 0
	for _, corpus := range corpora {
		if corpus == nil {
			return CalibrationReport{}, fmt.Errorf("%w: nil calibration corpus", ErrInvalidInput)
		}
		manifest, err := corpus.Manifest(ctx)
		if err != nil {
			return CalibrationReport{}, fmt.Errorf("load calibration corpus manifest: %w", err)
		}
		if err := validateCorpusManifest(manifest); err != nil {
			return CalibrationReport{}, err
		}
		if _, duplicate := seenManifestHashes[manifest.ManifestHash]; duplicate {
			return CalibrationReport{}, fmt.Errorf("%w: duplicate calibration corpus manifest %s", ErrInvalidInput, manifest.ManifestHash)
		}
		seenManifestHashes[manifest.ManifestHash] = struct{}{}
		if manifest.SampleCount > maxCalibrationExamples-declaredSamples {
			return CalibrationReport{}, fmt.Errorf("%w: calibration corpora exceed %d total examples", ErrInvalidInput, maxCalibrationExamples)
		}
		declaredSamples += manifest.SampleCount
		switch manifest.Kind {
		case ControlledMachineCorpus:
			machineManifestHashes = append(machineManifestHashes, manifest.ManifestHash)
		case LabeledHumanCorpus:
			humanManifestHashes = append(humanManifestHashes, manifest.ManifestHash)
		case CorrelatedHumanCorpus:
			correlatedManifestHashes = append(correlatedManifestHashes, manifest.ManifestHash)
			// Conversion correlation is diagnostic only. It may contribute a
			// human recall view but never upgrades the labeled-negative count
			// used for machine precision certification.
		default:
			return CalibrationReport{}, fmt.Errorf("%w: unknown corpus kind %q", ErrInvalidInput, manifest.Kind)
		}
		visit := &corpusVisit{
			manifest:       manifest,
			seenExampleIDs: make(map[string]struct{}, manifest.SampleCount),
		}
		err = corpus.ForEach(ctx, func(example LabeledExample) error {
			return run.visitExample(ctx, visit, example)
		})
		if err != nil {
			return CalibrationReport{}, err
		}
		if visit.exceededDeclaredCount {
			return CalibrationReport{}, fmt.Errorf("%w: corpus %q ignored the visitor's sample-bound error", ErrInvalidInput, manifest.Name)
		}
		if manifest.SampleCount >= 0 && visit.seen != manifest.SampleCount {
			return CalibrationReport{}, fmt.Errorf("%w: corpus %q manifest count=%d observed=%d", ErrInvalidInput, manifest.Name, manifest.SampleCount, visit.seen)
		}
	}

	report.MachineCorpusManifestHashes = sortedManifestHashes(machineManifestHashes)
	report.HumanCorpusManifestHashes = sortedManifestHashes(humanManifestHashes)
	report.CorrelatedCorpusManifestHashes = sortedManifestHashes(correlatedManifestHashes)
	if hasDuplicateSortedStrings(report.MachineCorpusManifestHashes) ||
		hasDuplicateSortedStrings(report.HumanCorpusManifestHashes) ||
		hasDuplicateSortedStrings(report.CorrelatedCorpusManifestHashes) {
		return CalibrationReport{}, fmt.Errorf("%w: duplicate calibration corpus manifests", ErrInvalidInput)
	}
	report.MachineCorpusManifestHash = combineManifestHashes(report.MachineCorpusManifestHashes)
	report.HumanCorpusManifestHash = combineManifestHashes(report.HumanCorpusManifestHashes)
	report.CorrelatedCorpusManifestHash = combineManifestHashes(report.CorrelatedCorpusManifestHashes)
	summarizeCalibrationRates(&report, policy)
	decideCalibrationResult(&report, policy)
	fingerprint, err := calibrationFingerprint(report)
	if err != nil {
		return CalibrationReport{}, err
	}
	report.Fingerprint = fingerprint
	return report, nil
}

// calibrationRun carries the cross-corpus state EvaluateCalibration threads
// through every example visit: the classifier under test, the report being
// built, the global sampling-unit dedupe set and the global example count.
type calibrationRun struct {
	classifier             *Classifier
	report                 *CalibrationReport
	seenSamplingUnitHashes map[string]struct{}
	totalSeen              int
}

// corpusVisit is the per-corpus bookkeeping for one ForEach walk.
type corpusVisit struct {
	manifest              CorpusManifest
	seen                  int
	exceededDeclaredCount bool
	seenExampleIDs        map[string]struct{}
}

// visitExample is the ForEach visitor body: it admits one labeled example
// (bounds, truth, identity and kind checks), classifies it, and folds the
// outcome into the report. Every rejection is ErrInvalidInput-wrapped except a
// classifier failure and a cancelled context, which propagate as-is.
func (run *calibrationRun) visitExample(ctx context.Context, visit *corpusVisit, example LabeledExample) error {
	manifest := visit.manifest
	if err := ctx.Err(); err != nil {
		return err
	}
	if visit.seen >= manifest.SampleCount || run.totalSeen >= maxCalibrationExamples {
		visit.exceededDeclaredCount = true
		return fmt.Errorf("%w: corpus %q exceeds its declared or global sample bound", ErrInvalidInput, manifest.Name)
	}
	visit.seen++
	run.totalSeen++
	if example.GroundTruth != Human && example.GroundTruth != Machine {
		return fmt.Errorf("%w: calibration truth must be human or machine", ErrInvalidInput)
	}
	if !calibrationExampleIDPattern.MatchString(example.ID) {
		return fmt.Errorf("%w: calibration example id %q is invalid", ErrInvalidInput, example.ID)
	}
	if _, duplicate := visit.seenExampleIDs[example.ID]; duplicate {
		return fmt.Errorf("%w: duplicate calibration example id %q", ErrInvalidInput, example.ID)
	}
	visit.seenExampleIDs[example.ID] = struct{}{}
	if !hashPattern.MatchString(example.SamplingUnitHash) {
		return fmt.Errorf("%w: calibration example %q has invalid sampling-unit hash", ErrInvalidInput, example.ID)
	}
	if _, duplicate := run.seenSamplingUnitHashes[example.SamplingUnitHash]; duplicate {
		return fmt.Errorf("%w: duplicate calibration sampling-unit hash %s", ErrInvalidInput, example.SamplingUnitHash)
	}
	run.seenSamplingUnitHashes[example.SamplingUnitHash] = struct{}{}
	if manifest.Kind == ControlledMachineCorpus && example.GroundTruth != Machine {
		return fmt.Errorf("%w: controlled-machine corpus contains non-machine truth", ErrInvalidInput)
	}
	if manifest.Kind == LabeledHumanCorpus && example.GroundTruth != Human {
		return fmt.Errorf("%w: labeled-human corpus contains non-human truth", ErrInvalidInput)
	}
	if manifest.Kind == CorrelatedHumanCorpus && example.GroundTruth != Human {
		return fmt.Errorf("%w: correlated-human corpus contains non-human truth", ErrInvalidInput)
	}
	result, err := run.classifier.Classify(example.Observation, example.Aggregate)
	if err != nil {
		return fmt.Errorf("classify calibration example %q: %w", example.ID, err)
	}
	return run.tallyExample(manifest, example, result)
}

// tallyExample folds one classified example into the per-source metrics and
// the report-wide counts. Certifying examples (non-seed controlled-machine and
// labeled-human) feed the confusion matrix and the sample counts the result
// decision reads; diagnostic examples (controlled seeds, correlated-human) are
// recorded separately and never certify.
func (run *calibrationRun) tallyExample(manifest CorpusManifest, example LabeledExample, result ClassificationResult) error {
	provider := strings.ToLower(strings.TrimSpace(example.Provider))
	if provider == "" {
		provider = strings.ToLower(strings.TrimSpace(manifest.Provider))
	}
	if provider == "" {
		provider = "unknown"
	}
	metrics := run.report.PerSource[provider]
	if metrics.Samples == 0 && len(run.report.PerSource) >= maxCalibrationSources {
		return fmt.Errorf("%w: calibration report exceeds %d distinct sources", ErrInvalidInput, maxCalibrationSources)
	}
	metrics.Samples++
	controlledSeed := manifest.Kind == ControlledMachineCorpus && example.Observation.IsSeed
	certifying := manifest.Kind != CorrelatedHumanCorpus && !controlledSeed
	if certifying {
		metrics.CertifyingSamples++
		recordConfusion(&metrics.CertifyingConfusion, example.GroundTruth, result.Classification)
	} else {
		metrics.DiagnosticSamples++
		recordConfusion(&metrics.DiagnosticConfusion, example.GroundTruth, result.Classification)
	}
	if controlledSeed {
		metrics.ControlledSeedSamples++
		run.report.ControlledSeedSampleCount++
	}
	if example.GroundTruth == Machine {
		metrics.MachineTruth++
	} else {
		metrics.HumanTruth++
	}
	if certifying {
		recordConfusion(&run.report.Confusion, example.GroundTruth, result.Classification)
		switch example.GroundTruth {
		case Machine:
			run.report.MachineSampleCount++
		case Human:
			run.report.HumanSampleCount++
		}
	}
	switch result.Classification {
	case Human:
		metrics.Human++
		if certifying {
			run.report.ClassifiedSampleCount++
		}
	case Machine:
		metrics.Machine++
		if certifying {
			run.report.ClassifiedSampleCount++
		}
	case Unknown:
		metrics.Unknown++
		if certifying {
			run.report.UnknownSampleCount++
		}
	}
	run.report.PerSource[provider] = metrics
	return nil
}

// summarizeCalibrationRates derives the point estimates and Wilson intervals
// for machine recall, false-machine-positive rate, human recall, the
// prevalence-adjusted machine precision (with Bonferroni-adjusted component
// bounds) and the unknown share from the report's certifying counts.
func summarizeCalibrationRates(report *CalibrationReport, policy CalibrationPolicy) {
	if report.MachineSampleCount > 0 {
		value := ratio(report.Confusion.MachineAsMachine, report.MachineSampleCount)
		report.MachineRecall = &value
		report.MachineRecallInterval = wilsonScoreInterval(
			report.Confusion.MachineAsMachine,
			report.MachineSampleCount,
			policy.ConfidenceLevel,
		)
	}
	if report.HumanSampleCount > 0 {
		fpr := ratio(report.Confusion.HumanAsMachine, report.HumanSampleCount)
		report.FalseMachinePositiveRate = &fpr
		report.FalsePositiveRateInterval = wilsonScoreInterval(
			report.Confusion.HumanAsMachine,
			report.HumanSampleCount,
			policy.ConfidenceLevel,
		)
		humanRecall := ratio(report.Confusion.HumanAsHuman, report.HumanSampleCount)
		report.HumanRecall = &humanRecall
		report.HumanRecallInterval = wilsonScoreInterval(
			report.Confusion.HumanAsHuman,
			report.HumanSampleCount,
			policy.ConfidenceLevel,
		)
	}
	if report.MachineRecall != nil && report.FalseMachinePositiveRate != nil {
		report.MachinePrecision = prevalenceAdjustedPrecision(
			*report.MachineRecall,
			*report.FalseMachinePositiveRate,
			policy.AssumedMachinePrevalence,
		)
		componentConfidence := 1 - (1-policy.ConfidenceLevel)/2
		recallForPrecision := wilsonScoreInterval(
			report.Confusion.MachineAsMachine,
			report.MachineSampleCount,
			componentConfidence,
		)
		falsePositiveForPrecision := wilsonScoreInterval(
			report.Confusion.HumanAsMachine,
			report.HumanSampleCount,
			componentConfidence,
		)
		if report.MachinePrecision != nil && recallForPrecision != nil && falsePositiveForPrecision != nil {
			lower := prevalenceAdjustedPrecisionValue(
				recallForPrecision.Lower,
				falsePositiveForPrecision.Upper,
				policy.AssumedMachinePrevalence,
			)
			upper := prevalenceAdjustedPrecisionValue(
				recallForPrecision.Upper,
				falsePositiveForPrecision.Lower,
				policy.AssumedMachinePrevalence,
			)
			report.MachinePrecisionInterval = &ConfidenceInterval{
				Lower: lower, Upper: upper, ConfidenceLevel: policy.ConfidenceLevel,
			}
		}
	}
	total := report.ClassifiedSampleCount + report.UnknownSampleCount
	report.UnknownShare = ratio(report.UnknownSampleCount, total)
	report.UnknownShareInterval = wilsonScoreInterval(
		report.UnknownSampleCount,
		total,
		policy.ConfidenceLevel,
	)
}

// decideCalibrationResult sets report.Result from the policy thresholds:
// "insufficient_corpus" below the sample minimums or without intervals, else
// "pass" when every interval bound clears its threshold, else "fail".
func decideCalibrationResult(report *CalibrationReport, policy CalibrationPolicy) {
	report.Result = "insufficient_corpus"
	if int(report.MachineSampleCount) >= policy.MinimumMachineSamples &&
		int(report.HumanSampleCount) >= policy.MinimumHumanSamples &&
		report.MachineRecallInterval != nil &&
		report.MachinePrecisionInterval != nil &&
		report.FalsePositiveRateInterval != nil {
		report.Result = "fail"
		if report.MachineRecallInterval.Lower >= policy.MinimumMachineRecall &&
			report.MachinePrecisionInterval.Lower >= policy.MinimumMachinePrecision &&
			report.FalsePositiveRateInterval.Upper <= policy.MaximumFalseMachinePositiveRate {
			report.Result = "pass"
		}
	}
}

func validateCorpusManifest(manifest CorpusManifest) error {
	provider := strings.ToLower(strings.TrimSpace(manifest.Provider))
	samplingUnit := strings.ToLower(strings.TrimSpace(manifest.SamplingUnit))
	if strings.TrimSpace(manifest.Name) == "" || len(manifest.Name) > 200 ||
		strings.ContainsAny(manifest.Name, "\x00\r\n") ||
		!versionPattern.MatchString(manifest.Version) ||
		!hashPattern.MatchString(manifest.ManifestHash) ||
		manifest.SampleCount < 0 || manifest.SampleCount > maxCalibrationExamples ||
		(provider != "" && !versionPattern.MatchString(provider)) ||
		!versionPattern.MatchString(samplingUnit) {
		return fmt.Errorf("%w: calibration corpus manifest is invalid", ErrInvalidInput)
	}
	return nil
}

func sortedManifestHashes(hashes []string) []string {
	// Preserve an explicit empty array in durable JSON receipts. A nil slice
	// marshals as JSON null, which is not the closed manifest-list contract.
	result := make([]string, len(hashes))
	copy(result, hashes)
	sort.Strings(result)
	return result
}

func hasDuplicateSortedStrings(values []string) bool {
	for index := 1; index < len(values); index++ {
		if values[index-1] == values[index] {
			return true
		}
	}
	return false
}

func combineManifestHashes(hashes []string) string {
	if len(hashes) == 0 {
		return ""
	}
	encoded, _ := json.Marshal(sortedManifestHashes(hashes))
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func ratio(numerator, denominator int64) float64 {
	if denominator <= 0 {
		return 0
	}
	return float64(numerator) / float64(denominator)
}

func recordConfusion(matrix *ConfusionMatrix, truth, prediction Classification) {
	if matrix == nil {
		return
	}
	switch truth {
	case Machine:
		switch prediction {
		case Machine:
			matrix.MachineAsMachine++
		case Human:
			matrix.MachineAsHuman++
		case Unknown:
			matrix.MachineAsUnknown++
		}
	case Human:
		switch prediction {
		case Human:
			matrix.HumanAsHuman++
		case Machine:
			matrix.HumanAsMachine++
		case Unknown:
			matrix.HumanAsUnknown++
		}
	}
}

func validateCalibrationPolicy(policy CalibrationPolicy) error {
	values := []float64{
		policy.MinimumMachineRecall,
		policy.MinimumMachinePrecision,
		policy.MaximumFalseMachinePositiveRate,
		policy.ConfidenceLevel,
		policy.AssumedMachinePrevalence,
	}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return fmt.Errorf("%w: calibration policy is invalid", ErrInvalidInput)
		}
	}
	if policy.MinimumMachineSamples < 1 || policy.MinimumMachineSamples > maxCalibrationExamples ||
		policy.MinimumHumanSamples < 1 || policy.MinimumHumanSamples > maxCalibrationExamples ||
		policy.MinimumMachineRecall < 0 || policy.MinimumMachineRecall > 1 ||
		policy.MinimumMachinePrecision < 0 || policy.MinimumMachinePrecision > 1 ||
		policy.MaximumFalseMachinePositiveRate < 0 || policy.MaximumFalseMachinePositiveRate > 1 ||
		policy.ConfidenceLevel < 0.80 || policy.ConfidenceLevel > 0.999 ||
		policy.AssumedMachinePrevalence <= 0 || policy.AssumedMachinePrevalence >= 1 ||
		!hashPattern.MatchString(policy.PrevalenceEvidenceManifestHash) {
		return fmt.Errorf("%w: calibration policy is invalid", ErrInvalidInput)
	}
	return nil
}

func prevalenceAdjustedPrecision(recall, falsePositiveRate, prevalence float64) *float64 {
	denominator := recall*prevalence + falsePositiveRate*(1-prevalence)
	if denominator <= 0 {
		return nil
	}
	value := recall * prevalence / denominator
	return &value
}

func prevalenceAdjustedPrecisionValue(recall, falsePositiveRate, prevalence float64) float64 {
	value := prevalenceAdjustedPrecision(recall, falsePositiveRate, prevalence)
	if value == nil {
		return 0
	}
	return *value
}

func wilsonScoreInterval(successes, trials int64, confidenceLevel float64) *ConfidenceInterval {
	if trials <= 0 {
		return nil
	}
	if successes < 0 {
		successes = 0
	}
	if successes > trials {
		successes = trials
	}
	p := float64(successes) / float64(trials)
	z := math.Sqrt2 * math.Erfinv(confidenceLevel)
	n := float64(trials)
	zSquared := z * z
	denominator := 1 + zSquared/n
	center := (p + zSquared/(2*n)) / denominator
	margin := z * math.Sqrt((p*(1-p)+zSquared/(4*n))/n) / denominator
	return &ConfidenceInterval{
		Lower:           math.Max(0, center-margin),
		Upper:           math.Min(1, center+margin),
		ConfidenceLevel: confidenceLevel,
	}
}

func calibrationFingerprint(report CalibrationReport) (string, error) {
	copy := report
	copy.ID = ""
	copy.RecordedAt = time.Time{}
	copy.Fingerprint = ""
	raw, err := json.Marshal(copy)
	if err != nil {
		return "", fmt.Errorf("fingerprint calibration report: %w", err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func calibrationReportPayload(report CalibrationReport) ([]byte, error) {
	copy := report
	copy.ID = ""
	copy.RecordedAt = time.Time{}
	raw, err := json.Marshal(copy)
	if err != nil {
		return nil, fmt.Errorf("encode calibration report payload: %w", err)
	}
	return raw, nil
}

// RecordCalibrationReport persists a hash-addressed, append-only methodology
// receipt. Raw examples remain in their governed corpora, not in this table.
func (repo *Repo) RecordCalibrationReport(
	ctx context.Context,
	classifier *Classifier,
	report CalibrationReport,
) (CalibrationReport, error) {
	if repo == nil || repo.Pool == nil || classifier == nil {
		return CalibrationReport{}, fmt.Errorf("%w: invalid calibration persistence input", ErrInvalidInput)
	}
	if err := validateCalibrationReportForPersistence(classifier, report); err != nil {
		return CalibrationReport{}, err
	}
	tx, err := db.WithWorkerScope(ctx, repo.Pool)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("open calibration transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.engagement_classifier_worker', 'true', true)`); err != nil {
		return CalibrationReport{}, fmt.Errorf("bind calibration worker: %w", err)
	}
	if err := ensureMethodology(ctx, tx, classifier.config, classifier.configHash); err != nil {
		return CalibrationReport{}, err
	}
	confusionJSON, err := json.Marshal(report.Confusion)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("encode calibration confusion: %w", err)
	}
	perSourceJSON, err := json.Marshal(report.PerSource)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("encode calibration source metrics: %w", err)
	}
	policyJSON, err := json.Marshal(report.Policy)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("encode calibration policy: %w", err)
	}
	machineManifestsJSON, err := json.Marshal(report.MachineCorpusManifestHashes)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("encode machine corpus manifests: %w", err)
	}
	humanManifestsJSON, err := json.Marshal(report.HumanCorpusManifestHashes)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("encode human corpus manifests: %w", err)
	}
	correlatedManifestsJSON, err := json.Marshal(report.CorrelatedCorpusManifestHashes)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("encode correlated corpus manifests: %w", err)
	}
	reportPayload, err := calibrationReportPayload(report)
	if err != nil {
		return CalibrationReport{}, err
	}
	id := uuid.NewString()
	var persistedID string
	var recordedAt time.Time
	_, err = tx.Exec(ctx, `
INSERT INTO engagement_classifier_calibration_reports (
    id, classifier_version, methodology_version, registry_version,
    configuration_hash, machine_corpus_manifest_hash,
    human_corpus_manifest_hash, correlated_human_corpus_manifest_hash,
    machine_corpus_manifest_hashes, human_corpus_manifest_hashes,
    correlated_human_corpus_manifest_hashes, controlled_seed_sample_count,
    report_payload,
    machine_sample_count, human_sample_count,
    classified_sample_count, unknown_sample_count, machine_recall,
    machine_precision, false_machine_positive_rate, human_recall,
    unknown_share, confusion_matrix, per_source_metrics, result,
    methodology_note, report_fingerprint, report_schema_version,
    calibration_policy, confidence_level,
    assumed_machine_prevalence, prevalence_evidence_manifest_hash,
    machine_recall_lower_bound, machine_recall_upper_bound,
    machine_precision_lower_bound, machine_precision_upper_bound,
    false_machine_positive_rate_lower_bound,
    false_machine_positive_rate_upper_bound,
    human_recall_lower_bound, human_recall_upper_bound,
    unknown_share_lower_bound, unknown_share_upper_bound
) VALUES (
    $1::uuid, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''),
    NULLIF($8, ''), $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb,
    $14, $15, $16, $17, $18, $19, $20, $21, $22,
    $23::jsonb, $24::jsonb, $25, $26, $27, $28,
    $29::jsonb, $30, $31, $32,
    $33, $34, $35, $36, $37, $38, $39, $40, $41, $42
)
ON CONFLICT (report_fingerprint) DO NOTHING`, id, report.ClassifierVersion,
		report.MethodologyVersion, report.RegistryVersion, report.ConfigurationHash,
		report.MachineCorpusManifestHash, report.HumanCorpusManifestHash,
		report.CorrelatedCorpusManifestHash,
		string(machineManifestsJSON), string(humanManifestsJSON),
		string(correlatedManifestsJSON), report.ControlledSeedSampleCount,
		string(reportPayload),
		report.MachineSampleCount, report.HumanSampleCount,
		report.ClassifiedSampleCount, report.UnknownSampleCount,
		report.MachineRecall, report.MachinePrecision,
		report.FalseMachinePositiveRate, report.HumanRecall, report.UnknownShare,
		string(confusionJSON), string(perSourceJSON), report.Result,
		report.MethodologyNote, report.Fingerprint, report.ReportSchemaVersion,
		string(policyJSON), report.Policy.ConfidenceLevel,
		report.Policy.AssumedMachinePrevalence,
		report.Policy.PrevalenceEvidenceManifestHash,
		intervalLower(report.MachineRecallInterval), intervalUpper(report.MachineRecallInterval),
		intervalLower(report.MachinePrecisionInterval), intervalUpper(report.MachinePrecisionInterval),
		intervalLower(report.FalsePositiveRateInterval), intervalUpper(report.FalsePositiveRateInterval),
		intervalLower(report.HumanRecallInterval), intervalUpper(report.HumanRecallInterval),
		intervalLower(report.UnknownShareInterval), intervalUpper(report.UnknownShareInterval))
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("persist calibration report: %w", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT id::text, recorded_at
  FROM engagement_classifier_calibration_reports
 WHERE report_fingerprint = $1
   AND report_payload = $2::jsonb`, report.Fingerprint, string(reportPayload)).Scan(&persistedID, &recordedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return CalibrationReport{}, fmt.Errorf("%w: calibration fingerprint exists with different payload", ErrIdempotencyConflict)
		}
		return CalibrationReport{}, fmt.Errorf("read exact calibration report replay: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return CalibrationReport{}, fmt.Errorf("commit calibration report: %w", err)
	}
	report.ID = persistedID
	report.RecordedAt = recordedAt
	return report, nil
}

func validateCalibrationReportForPersistence(classifier *Classifier, report CalibrationReport) error {
	if report.ReportSchemaVersion != CalibrationReportV2 || report.Fingerprint == "" ||
		report.ClassifierVersion != classifier.config.ClassifierVersion ||
		report.MethodologyVersion != classifier.config.MethodologyVersion ||
		report.RegistryVersion != classifier.config.RegistryVersion ||
		report.ConfigurationHash != classifier.configHash {
		return fmt.Errorf("%w: calibration report methodology identity is invalid", ErrInvalidInput)
	}
	if err := validateCalibrationPolicy(report.Policy); err != nil {
		return err
	}
	if err := validateCalibrationReportIntegrity(report); err != nil {
		return err
	}
	for _, interval := range []*ConfidenceInterval{
		report.MachineRecallInterval,
		report.MachinePrecisionInterval,
		report.FalsePositiveRateInterval,
		report.HumanRecallInterval,
		report.UnknownShareInterval,
	} {
		if interval == nil {
			continue
		}
		if math.IsNaN(interval.Lower) || math.IsNaN(interval.Upper) ||
			math.IsInf(interval.Lower, 0) || math.IsInf(interval.Upper, 0) ||
			interval.Lower < 0 || interval.Upper > 1 || interval.Lower > interval.Upper ||
			interval.ConfidenceLevel != report.Policy.ConfidenceLevel {
			return fmt.Errorf("%w: calibration confidence interval is invalid", ErrInvalidInput)
		}
	}
	expectedFingerprint, err := calibrationFingerprint(report)
	if err != nil {
		return err
	}
	if expectedFingerprint != report.Fingerprint {
		return fmt.Errorf("%w: calibration report fingerprint mismatch", ErrInvalidInput)
	}
	return nil
}

func intervalLower(interval *ConfidenceInterval) any {
	if interval == nil {
		return nil
	}
	return interval.Lower
}

func intervalUpper(interval *ConfidenceInterval) any {
	if interval == nil {
		return nil
	}
	return interval.Upper
}
