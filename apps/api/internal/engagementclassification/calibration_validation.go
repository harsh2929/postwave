// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Calibration reports are persisted as immutable methodology receipts.  A
// valid fingerprint proves that a value has not changed since it was hashed;
// it does not prove that the value was internally coherent when it was
// created.  validateCalibrationReportIntegrity independently reconstructs the
// report from its certifying confusion matrix and policy before persistence.
const calibrationMetricTolerance = 1e-12

func validateCalibrationReportIntegrity(report CalibrationReport) error {
	if report.ReportSchemaVersion != CalibrationReportV2 ||
		!versionPattern.MatchString(report.ClassifierVersion) ||
		!versionPattern.MatchString(report.MethodologyVersion) ||
		!versionPattern.MatchString(report.RegistryVersion) ||
		!hashPattern.MatchString(report.ConfigurationHash) {
		return invalidCalibrationReport("methodology identity is malformed")
	}
	for _, receipt := range []struct {
		name     string
		combined string
		hashes   []string
	}{
		{"machine corpus manifest", report.MachineCorpusManifestHash, report.MachineCorpusManifestHashes},
		{"human corpus manifest", report.HumanCorpusManifestHash, report.HumanCorpusManifestHashes},
		{"correlated corpus manifest", report.CorrelatedCorpusManifestHash, report.CorrelatedCorpusManifestHashes},
	} {
		if err := validateCalibrationManifestReceipt(receipt.name, receipt.combined, receipt.hashes); err != nil {
			return err
		}
	}
	if len(report.MachineCorpusManifestHashes)+len(report.HumanCorpusManifestHashes)+
		len(report.CorrelatedCorpusManifestHashes) > maxCalibrationCorpora {
		return invalidCalibrationReport("manifest evidence exceeds the corpus bound")
	}
	if !hashPattern.MatchString(report.Fingerprint) {
		return invalidCalibrationReport("fingerprint is malformed")
	}
	if strings.TrimSpace(report.MethodologyNote) == "" ||
		strings.ContainsAny(report.MethodologyNote, "\x00\r") {
		return invalidCalibrationReport("methodology note is malformed")
	}
	if err := validateCalibrationPolicy(report.Policy); err != nil {
		return err
	}

	if err := validateCalibrationReportCounts(report); err != nil {
		return err
	}
	if err := validateCalibrationSourceRollup(report); err != nil {
		return err
	}
	if err := validateCalibrationReportMetrics(report); err != nil {
		return err
	}

	expectedFingerprint, err := calibrationFingerprint(report)
	if err != nil {
		return err
	}
	if report.Fingerprint != expectedFingerprint {
		return invalidCalibrationReport("fingerprint does not cover the report contents")
	}
	return nil
}

func validateCalibrationReportCounts(report CalibrationReport) error {
	counts := map[string]int64{
		"machine samples":         report.MachineSampleCount,
		"human samples":           report.HumanSampleCount,
		"controlled-seed samples": report.ControlledSeedSampleCount,
		"classified samples":      report.ClassifiedSampleCount,
		"unknown samples":         report.UnknownSampleCount,
	}
	for name, count := range counts {
		if count < 0 || count > maxCalibrationExamples {
			return invalidCalibrationReport("%s count is outside the calibration bound", name)
		}
	}
	if err := validateCalibrationConfusion("aggregate certifying", report.Confusion); err != nil {
		return err
	}

	machineSamples := calibrationMachineTruth(report.Confusion)
	humanSamples := calibrationHumanTruth(report.Confusion)
	if machineSamples != report.MachineSampleCount || humanSamples != report.HumanSampleCount {
		return invalidCalibrationReport(
			"certifying confusion totals do not match machine/human sample counts",
		)
	}
	classified := report.Confusion.MachineAsMachine + report.Confusion.MachineAsHuman +
		report.Confusion.HumanAsMachine + report.Confusion.HumanAsHuman
	unknown := report.Confusion.MachineAsUnknown + report.Confusion.HumanAsUnknown
	if classified != report.ClassifiedSampleCount || unknown != report.UnknownSampleCount {
		return invalidCalibrationReport(
			"certifying confusion totals do not match classified/unknown sample counts",
		)
	}
	if report.ClassifiedSampleCount+report.UnknownSampleCount !=
		report.MachineSampleCount+report.HumanSampleCount {
		return invalidCalibrationReport("certifying sample totals are inconsistent")
	}
	if report.MachineSampleCount > 0 && report.MachineCorpusManifestHash == "" {
		return invalidCalibrationReport("machine samples lack a corpus manifest receipt")
	}
	if report.ControlledSeedSampleCount > 0 && report.MachineCorpusManifestHash == "" {
		return invalidCalibrationReport("controlled-seed samples lack a machine corpus manifest receipt")
	}
	if report.HumanSampleCount > 0 && report.HumanCorpusManifestHash == "" {
		return invalidCalibrationReport("human samples lack a corpus manifest receipt")
	}
	return nil
}

func validateCalibrationSourceRollup(report CalibrationReport) error {
	if len(report.PerSource) > maxCalibrationSources {
		return invalidCalibrationReport("per-source metrics exceed the source bound")
	}
	var certifyingRollup ConfusionMatrix
	var certifyingSamples int64
	var diagnosticSamples int64
	var diagnosticMachineTruth int64
	var diagnosticHumanTruth int64
	for source, metrics := range report.PerSource {
		if source == "" || source != strings.ToLower(strings.TrimSpace(source)) ||
			!versionPattern.MatchString(source) {
			return invalidCalibrationReport("per-source key %q is malformed", source)
		}
		for name, count := range map[string]int64{
			"samples":                 metrics.Samples,
			"certifying samples":      metrics.CertifyingSamples,
			"diagnostic samples":      metrics.DiagnosticSamples,
			"controlled-seed samples": metrics.ControlledSeedSamples,
			"machine truth":           metrics.MachineTruth,
			"human truth":             metrics.HumanTruth,
			"human predictions":       metrics.Human,
			"machine predictions":     metrics.Machine,
			"unknown predictions":     metrics.Unknown,
		} {
			if count < 0 || count > maxCalibrationExamples {
				return invalidCalibrationReport("source %q %s count is outside the calibration bound", source, name)
			}
		}
		if err := validateCalibrationConfusion(source+" certifying", metrics.CertifyingConfusion); err != nil {
			return err
		}
		if err := validateCalibrationConfusion(source+" diagnostic", metrics.DiagnosticConfusion); err != nil {
			return err
		}

		certifyingTotal := calibrationConfusionTotal(metrics.CertifyingConfusion)
		diagnosticTotal := calibrationConfusionTotal(metrics.DiagnosticConfusion)
		if metrics.CertifyingSamples != certifyingTotal ||
			metrics.DiagnosticSamples != diagnosticTotal ||
			metrics.Samples != certifyingTotal+diagnosticTotal {
			return invalidCalibrationReport("source %q sample counts do not match its confusion matrices", source)
		}
		if metrics.ControlledSeedSamples != calibrationMachineTruth(metrics.DiagnosticConfusion) {
			return invalidCalibrationReport("source %q controlled-seed count does not match diagnostic machine truth", source)
		}
		machineTruth := calibrationMachineTruth(metrics.CertifyingConfusion) +
			calibrationMachineTruth(metrics.DiagnosticConfusion)
		humanTruth := calibrationHumanTruth(metrics.CertifyingConfusion) +
			calibrationHumanTruth(metrics.DiagnosticConfusion)
		if metrics.MachineTruth != machineTruth || metrics.HumanTruth != humanTruth ||
			metrics.Samples != machineTruth+humanTruth {
			return invalidCalibrationReport("source %q truth counts do not match its confusion matrices", source)
		}
		humanPredictions := calibrationHumanPredictions(metrics.CertifyingConfusion) +
			calibrationHumanPredictions(metrics.DiagnosticConfusion)
		machinePredictions := calibrationMachinePredictions(metrics.CertifyingConfusion) +
			calibrationMachinePredictions(metrics.DiagnosticConfusion)
		unknownPredictions := calibrationUnknownPredictions(metrics.CertifyingConfusion) +
			calibrationUnknownPredictions(metrics.DiagnosticConfusion)
		if metrics.Human != humanPredictions || metrics.Machine != machinePredictions ||
			metrics.Unknown != unknownPredictions ||
			metrics.Samples != humanPredictions+machinePredictions+unknownPredictions {
			return invalidCalibrationReport("source %q prediction counts do not match its confusion matrices", source)
		}

		addCalibrationConfusion(&certifyingRollup, metrics.CertifyingConfusion)
		certifyingSamples += certifyingTotal
		diagnosticSamples += diagnosticTotal
		diagnosticMachineTruth += calibrationMachineTruth(metrics.DiagnosticConfusion)
		diagnosticHumanTruth += calibrationHumanTruth(metrics.DiagnosticConfusion)
	}
	if certifyingRollup != report.Confusion ||
		certifyingSamples != report.MachineSampleCount+report.HumanSampleCount {
		return invalidCalibrationReport("per-source certifying metrics do not roll up to the report")
	}
	if certifyingSamples > maxCalibrationExamples-diagnosticSamples {
		return invalidCalibrationReport("per-source metrics exceed the global calibration sample bound")
	}
	if diagnosticMachineTruth != report.ControlledSeedSampleCount {
		return invalidCalibrationReport("per-source controlled-seed samples do not roll up to the report")
	}
	if diagnosticMachineTruth > 0 && report.MachineCorpusManifestHash == "" {
		return invalidCalibrationReport("diagnostic machine samples lack a corpus manifest receipt")
	}
	if diagnosticHumanTruth > 0 && report.CorrelatedCorpusManifestHash == "" {
		return invalidCalibrationReport("diagnostic human samples lack a correlated corpus receipt")
	}
	return nil
}

func validateCalibrationManifestReceipt(name, combined string, hashes []string) error {
	if (combined == "") != (len(hashes) == 0) {
		return invalidCalibrationReport("%s aggregate/list shape is inconsistent", name)
	}
	for index, hash := range hashes {
		if !hashPattern.MatchString(hash) {
			return invalidCalibrationReport("%s hash is malformed", name)
		}
		if index > 0 && hashes[index-1] >= hash {
			return invalidCalibrationReport("%s hashes are not a unique sorted evidence list", name)
		}
	}
	if !sort.StringsAreSorted(hashes) {
		return invalidCalibrationReport("%s hashes are not sorted", name)
	}
	if combined != "" && (!hashPattern.MatchString(combined) || combineManifestHashes(hashes) != combined) {
		return invalidCalibrationReport("%s aggregate hash is malformed or inconsistent", name)
	}
	return nil
}

func validateCalibrationReportMetrics(report CalibrationReport) error {
	policy := report.Policy
	var machineRecall *float64
	var machineRecallInterval *ConfidenceInterval
	if report.MachineSampleCount > 0 {
		value := ratio(report.Confusion.MachineAsMachine, report.MachineSampleCount)
		machineRecall = &value
		machineRecallInterval = wilsonScoreInterval(
			report.Confusion.MachineAsMachine,
			report.MachineSampleCount,
			policy.ConfidenceLevel,
		)
	}
	var falsePositiveRate *float64
	var falsePositiveRateInterval *ConfidenceInterval
	var humanRecall *float64
	var humanRecallInterval *ConfidenceInterval
	if report.HumanSampleCount > 0 {
		fpr := ratio(report.Confusion.HumanAsMachine, report.HumanSampleCount)
		falsePositiveRate = &fpr
		falsePositiveRateInterval = wilsonScoreInterval(
			report.Confusion.HumanAsMachine,
			report.HumanSampleCount,
			policy.ConfidenceLevel,
		)
		recall := ratio(report.Confusion.HumanAsHuman, report.HumanSampleCount)
		humanRecall = &recall
		humanRecallInterval = wilsonScoreInterval(
			report.Confusion.HumanAsHuman,
			report.HumanSampleCount,
			policy.ConfidenceLevel,
		)
	}

	var machinePrecision *float64
	var machinePrecisionInterval *ConfidenceInterval
	if machineRecall != nil && falsePositiveRate != nil {
		machinePrecision = prevalenceAdjustedPrecision(
			*machineRecall,
			*falsePositiveRate,
			policy.AssumedMachinePrevalence,
		)
		// An undefined point estimate must not acquire a synthetic [0,1]
		// interval.  The gate must remain uncomputable in that shape.
		if machinePrecision != nil {
			componentConfidence := 1 - (1-policy.ConfidenceLevel)/2
			recallBounds := wilsonScoreInterval(
				report.Confusion.MachineAsMachine,
				report.MachineSampleCount,
				componentConfidence,
			)
			falsePositiveBounds := wilsonScoreInterval(
				report.Confusion.HumanAsMachine,
				report.HumanSampleCount,
				componentConfidence,
			)
			machinePrecisionInterval = &ConfidenceInterval{
				Lower: prevalenceAdjustedPrecisionValue(
					recallBounds.Lower,
					falsePositiveBounds.Upper,
					policy.AssumedMachinePrevalence,
				),
				Upper: prevalenceAdjustedPrecisionValue(
					recallBounds.Upper,
					falsePositiveBounds.Lower,
					policy.AssumedMachinePrevalence,
				),
				ConfidenceLevel: policy.ConfidenceLevel,
			}
		}
	}
	total := report.ClassifiedSampleCount + report.UnknownSampleCount
	unknownShare := ratio(report.UnknownSampleCount, total)
	unknownShareInterval := wilsonScoreInterval(
		report.UnknownSampleCount,
		total,
		policy.ConfidenceLevel,
	)

	for _, comparison := range []struct {
		name     string
		actual   *float64
		expected *float64
	}{
		{"machine recall", report.MachineRecall, machineRecall},
		{"machine precision", report.MachinePrecision, machinePrecision},
		{"false-machine-positive rate", report.FalseMachinePositiveRate, falsePositiveRate},
		{"human recall", report.HumanRecall, humanRecall},
	} {
		if err := compareCalibrationMetric(comparison.name, comparison.actual, comparison.expected); err != nil {
			return err
		}
	}
	if !validCalibrationProbability(report.UnknownShare) ||
		!calibrationFloatEqual(report.UnknownShare, unknownShare) {
		return invalidCalibrationReport("unknown share is inconsistent with sample counts")
	}
	for _, comparison := range []struct {
		name     string
		actual   *ConfidenceInterval
		expected *ConfidenceInterval
	}{
		{"machine recall", report.MachineRecallInterval, machineRecallInterval},
		{"machine precision", report.MachinePrecisionInterval, machinePrecisionInterval},
		{"false-machine-positive rate", report.FalsePositiveRateInterval, falsePositiveRateInterval},
		{"human recall", report.HumanRecallInterval, humanRecallInterval},
		{"unknown share", report.UnknownShareInterval, unknownShareInterval},
	} {
		if err := compareCalibrationInterval(comparison.name, comparison.actual, comparison.expected); err != nil {
			return err
		}
	}

	expectedResult := "insufficient_corpus"
	if int(report.MachineSampleCount) >= policy.MinimumMachineSamples &&
		int(report.HumanSampleCount) >= policy.MinimumHumanSamples &&
		machineRecallInterval != nil && machinePrecisionInterval != nil &&
		falsePositiveRateInterval != nil {
		expectedResult = "fail"
		if machineRecallInterval.Lower >= policy.MinimumMachineRecall &&
			machinePrecisionInterval.Lower >= policy.MinimumMachinePrecision &&
			falsePositiveRateInterval.Upper <= policy.MaximumFalseMachinePositiveRate {
			expectedResult = "pass"
		}
	}
	if report.Result != expectedResult {
		return invalidCalibrationReport("result %q is inconsistent with policy gate %q", report.Result, expectedResult)
	}
	return nil
}

func validateCalibrationConfusion(name string, matrix ConfusionMatrix) error {
	for _, count := range []int64{
		matrix.MachineAsMachine,
		matrix.MachineAsHuman,
		matrix.MachineAsUnknown,
		matrix.HumanAsHuman,
		matrix.HumanAsMachine,
		matrix.HumanAsUnknown,
	} {
		if count < 0 || count > maxCalibrationExamples {
			return invalidCalibrationReport("%s confusion matrix contains an invalid count", name)
		}
	}
	return nil
}

func calibrationMachineTruth(matrix ConfusionMatrix) int64 {
	return matrix.MachineAsMachine + matrix.MachineAsHuman + matrix.MachineAsUnknown
}

func calibrationHumanTruth(matrix ConfusionMatrix) int64 {
	return matrix.HumanAsHuman + matrix.HumanAsMachine + matrix.HumanAsUnknown
}

func calibrationHumanPredictions(matrix ConfusionMatrix) int64 {
	return matrix.MachineAsHuman + matrix.HumanAsHuman
}

func calibrationMachinePredictions(matrix ConfusionMatrix) int64 {
	return matrix.MachineAsMachine + matrix.HumanAsMachine
}

func calibrationUnknownPredictions(matrix ConfusionMatrix) int64 {
	return matrix.MachineAsUnknown + matrix.HumanAsUnknown
}

func calibrationConfusionTotal(matrix ConfusionMatrix) int64 {
	return calibrationMachineTruth(matrix) + calibrationHumanTruth(matrix)
}

func addCalibrationConfusion(target *ConfusionMatrix, value ConfusionMatrix) {
	target.MachineAsMachine += value.MachineAsMachine
	target.MachineAsHuman += value.MachineAsHuman
	target.MachineAsUnknown += value.MachineAsUnknown
	target.HumanAsHuman += value.HumanAsHuman
	target.HumanAsMachine += value.HumanAsMachine
	target.HumanAsUnknown += value.HumanAsUnknown
}

func compareCalibrationMetric(name string, actual, expected *float64) error {
	if actual == nil || expected == nil {
		if actual != nil || expected != nil {
			return invalidCalibrationReport("%s point-estimate shape is inconsistent with its denominator", name)
		}
		return nil
	}
	if !validCalibrationProbability(*actual) || !calibrationFloatEqual(*actual, *expected) {
		return invalidCalibrationReport("%s point estimate is inconsistent with the confusion matrix", name)
	}
	return nil
}

func compareCalibrationInterval(name string, actual, expected *ConfidenceInterval) error {
	if actual == nil || expected == nil {
		if actual != nil || expected != nil {
			return invalidCalibrationReport("%s confidence-interval shape is inconsistent with its point estimate", name)
		}
		return nil
	}
	if !validCalibrationProbability(actual.Lower) ||
		!validCalibrationProbability(actual.Upper) ||
		actual.Lower > actual.Upper ||
		!calibrationFloatEqual(actual.ConfidenceLevel, expected.ConfidenceLevel) ||
		!calibrationFloatEqual(actual.Lower, expected.Lower) ||
		!calibrationFloatEqual(actual.Upper, expected.Upper) {
		return invalidCalibrationReport("%s confidence interval is inconsistent with its Wilson reconstruction", name)
	}
	return nil
}

func validCalibrationProbability(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 1
}

func calibrationFloatEqual(left, right float64) bool {
	if math.IsNaN(left) || math.IsNaN(right) || math.IsInf(left, 0) || math.IsInf(right, 0) {
		return false
	}
	difference := math.Abs(left - right)
	scale := math.Max(1, math.Max(math.Abs(left), math.Abs(right)))
	return difference <= calibrationMetricTolerance*scale
}

func invalidCalibrationReport(format string, arguments ...any) error {
	return fmt.Errorf("%w: calibration report "+format, append([]any{ErrInvalidInput}, arguments...)...)
}
