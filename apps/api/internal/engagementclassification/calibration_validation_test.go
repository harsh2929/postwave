// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestCalibrationReportIntegrityAcceptsEvaluatorOutput(t *testing.T) {
	report := genuineCalibrationIntegrityReport(t)
	if err := validateCalibrationReportIntegrity(report); err != nil {
		t.Fatalf("genuine EvaluateCalibration report was rejected: %v", err)
	}
}

func TestCalibrationReportIntegrityRejectsForgedReceipts(t *testing.T) {
	tests := []struct {
		name       string
		wantDetail string
		mutate     func(*CalibrationReport)
	}{
		{
			name: "negative sample count", wantDetail: "count is outside",
			mutate: func(report *CalibrationReport) { report.MachineSampleCount = -1 },
		},
		{
			name: "truth confusion mismatch", wantDetail: "machine/human sample counts",
			mutate: func(report *CalibrationReport) { report.Confusion.MachineAsUnknown++ },
		},
		{
			name: "classified count mismatch", wantDetail: "classified/unknown sample counts",
			mutate: func(report *CalibrationReport) { report.ClassifiedSampleCount++ },
		},
		{
			name: "forged point estimate", wantDetail: "machine recall point estimate",
			mutate: func(report *CalibrationReport) {
				value := 0.75
				report.MachineRecall = &value
			},
		},
		{
			name: "forged prevalence-adjusted precision", wantDetail: "machine precision point estimate",
			mutate: func(report *CalibrationReport) {
				value := 0.5
				report.MachinePrecision = &value
			},
		},
		{
			name: "forged Wilson bound", wantDetail: "machine recall confidence interval",
			mutate: func(report *CalibrationReport) {
				interval := *report.MachineRecallInterval
				interval.Lower /= 2
				report.MachineRecallInterval = &interval
			},
		},
		{
			name: "forged prevalence-adjusted bound", wantDetail: "machine precision confidence interval",
			mutate: func(report *CalibrationReport) {
				interval := *report.MachinePrecisionInterval
				interval.Lower /= 2
				report.MachinePrecisionInterval = &interval
			},
		},
		{
			name: "forged unknown share", wantDetail: "unknown share is inconsistent",
			mutate: func(report *CalibrationReport) { report.UnknownShare = 0.25 },
		},
		{
			name: "point without matching interval shape", wantDetail: "machine precision point-estimate shape",
			mutate: func(report *CalibrationReport) { report.MachinePrecision = nil },
		},
		{
			name: "interval without matching point shape", wantDetail: "human recall confidence-interval shape",
			mutate: func(report *CalibrationReport) { report.HumanRecallInterval = nil },
		},
		{
			name: "policy result forgery", wantDetail: "inconsistent with policy gate",
			mutate: func(report *CalibrationReport) { report.Result = "fail" },
		},
		{
			name: "malformed methodology version", wantDetail: "methodology identity is malformed",
			mutate: func(report *CalibrationReport) { report.MethodologyVersion = "BAD VERSION" },
		},
		{
			name: "malformed corpus hash", wantDetail: "machine corpus manifest aggregate hash",
			mutate: func(report *CalibrationReport) { report.MachineCorpusManifestHash = "not-a-hash" },
		},
		{
			name: "manifest list aggregate mismatch", wantDetail: "aggregate hash",
			mutate: func(report *CalibrationReport) {
				report.MachineCorpusManifestHashes[0] = strings.Repeat("b", 64)
			},
		},
		{
			name: "controlled seed rollup mismatch", wantDetail: "controlled-seed samples do not roll up",
			mutate: func(report *CalibrationReport) { report.ControlledSeedSampleCount++ },
		},
		{
			name: "internally coherent source diverges from aggregate", wantDetail: "do not roll up",
			mutate: func(report *CalibrationReport) {
				metrics := report.PerSource["gmail"]
				metrics.Samples++
				metrics.CertifyingSamples++
				metrics.MachineTruth++
				metrics.Machine++
				metrics.CertifyingConfusion.MachineAsMachine++
				report.PerSource["gmail"] = metrics
			},
		},
		{
			name: "source truth ledger mismatch", wantDetail: "truth counts do not match",
			mutate: func(report *CalibrationReport) {
				metrics := report.PerSource["gmail"]
				metrics.MachineTruth++
				report.PerSource["gmail"] = metrics
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			report := genuineCalibrationIntegrityReport(t)
			test.mutate(&report)
			refingerprintCalibrationIntegrityReport(t, &report)
			err := validateCalibrationReportIntegrity(report)
			if err == nil || !errors.Is(err, ErrInvalidInput) ||
				!strings.Contains(err.Error(), test.wantDetail) {
				t.Fatalf("validateCalibrationReportIntegrity() error = %v, want ErrInvalidInput containing %q", err, test.wantDetail)
			}
		})
	}
}

func TestCalibrationReportIntegrityRejectsHashMismatch(t *testing.T) {
	report := genuineCalibrationIntegrityReport(t)
	report.Fingerprint = strings.Repeat("a", 64)
	if report.Fingerprint == mustCalibrationIntegrityFingerprint(t, report) {
		report.Fingerprint = strings.Repeat("b", 64)
	}
	err := validateCalibrationReportIntegrity(report)
	if err == nil || !errors.Is(err, ErrInvalidInput) || !strings.Contains(err.Error(), "fingerprint does not cover") {
		t.Fatalf("fingerprint mismatch error = %v", err)
	}
}

func genuineCalibrationIntegrityReport(t *testing.T) CalibrationReport {
	t.Helper()
	classifier := mustClassifier(t, DefaultConfig(), registryEntry(
		"R_CALIBRATION_INTEGRITY_MACHINE",
		MatchUASubstring,
		"IntegrityMachineBot",
		SubtypeLinkChecker,
		1,
	))
	machineObservation := validObservation()
	machineObservation.UserAgent = "IntegrityMachineBot/1.0"
	seedObservation := validObservation()
	seedObservation.IsSeed = true
	humanObservation := validObservation()
	dwell := int64(30_000)
	humanObservation.DwellMilliseconds = &dwell
	correlatedObservation := humanObservation

	policy := calibrationTestPolicy()
	policy.MinimumMachineSamples = 1
	policy.MinimumHumanSamples = 1
	policy.MinimumMachineRecall = 0
	policy.MinimumMachinePrecision = 0
	policy.MaximumFalseMachinePositiveRate = 1
	report, err := EvaluateCalibration(
		context.Background(),
		classifier,
		policy,
		calibrationCorpus(ControlledMachineCorpus, "a", LabeledExample{
			ID: "integrity-machine-1", Provider: "gmail", GroundTruth: Machine,
			Observation: machineObservation,
		}),
		calibrationCorpus(LabeledHumanCorpus, "b", LabeledExample{
			ID: "integrity-human-1", Provider: "gmail", GroundTruth: Human,
			Observation: humanObservation,
		}),
		calibrationCorpus(ControlledMachineCorpus, "c", LabeledExample{
			ID: "integrity-seed-1", Provider: "gmail", GroundTruth: Machine,
			Observation: seedObservation,
		}),
		calibrationCorpus(CorrelatedHumanCorpus, "d", LabeledExample{
			ID: "integrity-correlated-1", Provider: "gmail", GroundTruth: Human,
			Observation: correlatedObservation,
		}),
	)
	if err != nil {
		t.Fatalf("EvaluateCalibration: %v", err)
	}
	if report.Result != "pass" {
		t.Fatalf("test setup produced result %q, want pass", report.Result)
	}
	return report
}

func refingerprintCalibrationIntegrityReport(t *testing.T, report *CalibrationReport) {
	t.Helper()
	report.Fingerprint = ""
	report.Fingerprint = mustCalibrationIntegrityFingerprint(t, *report)
}

func mustCalibrationIntegrityFingerprint(t *testing.T, report CalibrationReport) string {
	t.Helper()
	fingerprint, err := calibrationFingerprint(report)
	if err != nil {
		t.Fatalf("calibrationFingerprint: %v", err)
	}
	return fingerprint
}
