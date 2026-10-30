// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math"
	"strings"
	"testing"
)

type sliceCorpus struct {
	manifest CorpusManifest
	examples []LabeledExample
}

func calibrationTestPolicy() CalibrationPolicy {
	policy := DefaultCalibrationPolicy()
	policy.AssumedMachinePrevalence = 0.50
	policy.PrevalenceEvidenceManifestHash = repeat("e", 64)
	return policy
}

type ignoringVisitorErrorCorpus struct {
	manifest CorpusManifest
	example  LabeledExample
}

func (corpus ignoringVisitorErrorCorpus) Manifest(context.Context) (CorpusManifest, error) {
	return corpus.manifest, nil
}

func (corpus ignoringVisitorErrorCorpus) ForEach(
	_ context.Context,
	visit func(LabeledExample) error,
) error {
	_ = visit(corpus.example)
	second := corpus.example
	second.ID = "second-example"
	_ = visit(second)
	return nil
}

func TestCalibrationRejectsDuplicateEvidence(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	observation.IsSeed = true
	corpus := calibrationCorpus(ControlledMachineCorpus, "7", LabeledExample{
		ID: "machine-1", GroundTruth: Machine, Observation: observation,
	})
	_, err := EvaluateCalibration(
		context.Background(), classifier, calibrationTestPolicy(), corpus, corpus,
	)
	if err == nil || !strings.Contains(err.Error(), "duplicate calibration corpus manifest") {
		t.Fatalf("duplicate corpus err=%v", err)
	}

	duplicatedExamples := calibrationCorpus(
		ControlledMachineCorpus,
		"8",
		LabeledExample{ID: "machine-1", GroundTruth: Machine, Observation: observation},
		LabeledExample{ID: "machine-1", GroundTruth: Machine, Observation: observation},
	)
	_, err = EvaluateCalibration(
		context.Background(), classifier, calibrationTestPolicy(), duplicatedExamples,
	)
	if err == nil || !strings.Contains(err.Error(), "duplicate calibration example id") {
		t.Fatalf("duplicate example err=%v", err)
	}
}

func (corpus sliceCorpus) Manifest(context.Context) (CorpusManifest, error) {
	return corpus.manifest, nil
}

func (corpus sliceCorpus) ForEach(_ context.Context, visit func(LabeledExample) error) error {
	for _, example := range corpus.examples {
		if err := visit(example); err != nil {
			return err
		}
	}
	return nil
}

func calibrationCorpus(kind CorpusKind, hashByte string, examples ...LabeledExample) sliceCorpus {
	for index := range examples {
		if examples[index].SamplingUnitHash == "" {
			digest := sha256.Sum256([]byte(examples[index].ID))
			examples[index].SamplingUnitHash = hex.EncodeToString(digest[:])
		}
	}
	return sliceCorpus{
		manifest: CorpusManifest{
			Name: "fixture-" + string(kind), Kind: kind, Version: "corpus.v1",
			ManifestHash: repeat(hashByte, 64), SampleCount: len(examples), Provider: "fixture",
			SamplingUnit: "event",
		},
		examples: examples,
	}
}

func calibrationMachineClassifier(t *testing.T) *Classifier {
	t.Helper()
	return mustClassifier(t, DefaultConfig(), registryEntry(
		"R_CALIBRATION_MACHINE_UA", MatchUASubstring, "CalibrationMachineAgent",
		SubtypeLinkChecker, 1,
	))
}

func calibrationMachineObservation() ObservationInput {
	observation := validObservation()
	observation.UserAgent = "CalibrationMachineAgent/1.0"
	return observation
}

func repeat(value string, count int) string {
	out := ""
	for index := 0; index < count; index++ {
		out += value
	}
	return out
}

func TestCalibrationRequiresMachineAndLabeledHumanCorporaForPrecision(t *testing.T) {
	classifier := calibrationMachineClassifier(t)
	machineObservation := calibrationMachineObservation()
	humanObservation := validObservation()
	dwell := int64(30_000)
	humanObservation.DwellMilliseconds = &dwell
	machine := calibrationCorpus(ControlledMachineCorpus, "1", LabeledExample{
		ID: "machine-1", Provider: "gmail", GroundTruth: Machine,
		Observation: machineObservation,
	})
	human := calibrationCorpus(LabeledHumanCorpus, "2", LabeledExample{
		ID: "human-1", Provider: "gmail", GroundTruth: Human,
		Observation: humanObservation,
	})
	policy := calibrationTestPolicy()
	policy.MinimumMachineSamples = 1
	policy.MinimumHumanSamples = 1
	policy.MinimumMachineRecall = 0
	policy.MinimumMachinePrecision = 0
	policy.MaximumFalseMachinePositiveRate = 1
	report, err := EvaluateCalibration(context.Background(), classifier, policy, machine, human)
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != "pass" || report.MachineRecall == nil || *report.MachineRecall != 1 ||
		report.MachinePrecision == nil || *report.MachinePrecision != 1 ||
		report.FalseMachinePositiveRate == nil || *report.FalseMachinePositiveRate != 0 ||
		report.Fingerprint == "" {
		t.Fatalf("calibration report = %+v", report)
	}
	metrics := report.PerSource["gmail"]
	if metrics.CertifyingSamples != 2 || metrics.DiagnosticSamples != 0 ||
		metrics.CertifyingConfusion.MachineAsMachine != 1 ||
		metrics.CertifyingConfusion.HumanAsHuman != 1 {
		t.Fatalf("provider-specific certifying confusion is not reconstructable: %+v", metrics)
	}
}

func TestCalibrationGatesOnConfidenceBoundsNotPointEstimates(t *testing.T) {
	classifier := calibrationMachineClassifier(t)
	machineObservation := calibrationMachineObservation()
	humanObservation := validObservation()
	dwell := int64(30_000)
	humanObservation.DwellMilliseconds = &dwell

	build := func(count int, hashByte string) (sliceCorpus, sliceCorpus) {
		humanHashByte := "c"
		if hashByte == "b" {
			humanHashByte = "d"
		}
		machineExamples := make([]LabeledExample, 0, count)
		humanExamples := make([]LabeledExample, 0, count)
		for index := 0; index < count; index++ {
			machineExamples = append(machineExamples, LabeledExample{
				ID: fmt.Sprintf("machine-%d", index), GroundTruth: Machine,
				Observation: machineObservation,
			})
			humanExamples = append(humanExamples, LabeledExample{
				ID: fmt.Sprintf("human-%d", index), GroundTruth: Human,
				Observation: humanObservation,
			})
		}
		return calibrationCorpus(ControlledMachineCorpus, hashByte, machineExamples...),
			calibrationCorpus(LabeledHumanCorpus, humanHashByte, humanExamples...)
	}

	policy := calibrationTestPolicy()
	policy.MinimumMachineSamples = 100
	policy.MinimumHumanSamples = 100
	smallMachine, smallHuman := build(100, "a")
	small, err := EvaluateCalibration(context.Background(), classifier, policy, smallMachine, smallHuman)
	if err != nil {
		t.Fatal(err)
	}
	if small.MachineRecall == nil || *small.MachineRecall != 1 ||
		small.MachinePrecision == nil || *small.MachinePrecision != 1 ||
		small.FalseMachinePositiveRate == nil || *small.FalseMachinePositiveRate != 0 ||
		small.Result != "fail" || small.MachinePrecisionInterval == nil ||
		small.MachinePrecisionInterval.Lower >= policy.MinimumMachinePrecision ||
		small.FalsePositiveRateInterval == nil ||
		small.FalsePositiveRateInterval.Upper <= policy.MaximumFalseMachinePositiveRate {
		t.Fatalf("small perfect corpus bypassed confidence gate: %+v", small)
	}

	policy.MinimumMachineSamples = 1000
	policy.MinimumHumanSamples = 1000
	largeMachine, largeHuman := build(1000, "b")
	large, err := EvaluateCalibration(context.Background(), classifier, policy, largeMachine, largeHuman)
	if err != nil {
		t.Fatal(err)
	}
	if large.Result != "pass" || large.MachineRecallInterval == nil ||
		large.MachineRecallInterval.Lower < policy.MinimumMachineRecall ||
		large.MachinePrecisionInterval == nil ||
		large.MachinePrecisionInterval.Lower < policy.MinimumMachinePrecision ||
		large.FalsePositiveRateInterval == nil ||
		large.FalsePositiveRateInterval.Upper > policy.MaximumFalseMachinePositiveRate {
		t.Fatalf("large perfect corpus did not satisfy confidence gate: %+v", large)
	}
}

func TestMachinePrecisionUsesDeclaredPrevalenceNotCorpusMix(t *testing.T) {
	classifier := calibrationMachineClassifier(t)
	policy := calibrationTestPolicy()
	policy.AssumedMachinePrevalence = 0.05
	policy.MinimumMachineSamples = 1
	policy.MinimumHumanSamples = 1

	machineObservation := calibrationMachineObservation()
	humanObservation := validObservation()
	dwell := int64(30_000)
	humanObservation.DwellMilliseconds = &dwell
	falsePositive := calibrationMachineObservation()

	buildMachine := func(count int, hashByte string) sliceCorpus {
		examples := make([]LabeledExample, 0, count)
		for index := 0; index < count; index++ {
			examples = append(examples, LabeledExample{
				ID: fmt.Sprintf("machine-mix-%d", index), GroundTruth: Machine,
				Observation: machineObservation,
			})
		}
		return calibrationCorpus(ControlledMachineCorpus, hashByte, examples...)
	}
	humanExamples := []LabeledExample{{
		ID: "human-false-positive", GroundTruth: Human, Observation: falsePositive,
	}}
	for index := 1; index < 10; index++ {
		humanExamples = append(humanExamples, LabeledExample{
			ID: fmt.Sprintf("human-mix-%d", index), GroundTruth: Human,
			Observation: humanObservation,
		})
	}
	humanCorpus := calibrationCorpus(LabeledHumanCorpus, "6", humanExamples...)

	balanced, err := EvaluateCalibration(
		context.Background(), classifier, policy, buildMachine(10, "7"), humanCorpus,
	)
	if err != nil {
		t.Fatal(err)
	}
	oversampled, err := EvaluateCalibration(
		context.Background(), classifier, policy, buildMachine(100, "8"), humanCorpus,
	)
	if err != nil {
		t.Fatal(err)
	}
	if balanced.MachinePrecision == nil || oversampled.MachinePrecision == nil ||
		*balanced.MachinePrecision != *oversampled.MachinePrecision {
		t.Fatalf("precision changed with case-control sample mix: balanced=%v oversampled=%v",
			balanced.MachinePrecision, oversampled.MachinePrecision)
	}
	want := 0.05 / (0.05 + 0.10*0.95)
	if math.Abs(*balanced.MachinePrecision-want) > 1e-12 {
		t.Fatalf("prevalence-adjusted precision=%f, want=%f", *balanced.MachinePrecision, want)
	}
	pooledBalanced := float64(10) / float64(10+1)
	pooledOversampled := float64(100) / float64(100+1)
	if pooledBalanced == pooledOversampled {
		t.Fatal("test setup did not vary pooled case-control precision")
	}

	differentPolicy := policy
	differentPolicy.AssumedMachinePrevalence = 0.50
	differentPolicy.PrevalenceEvidenceManifestHash = repeat("f", 64)
	differentPrevalence, err := EvaluateCalibration(
		context.Background(), classifier, differentPolicy, buildMachine(10, "9"), humanCorpus,
	)
	if err != nil {
		t.Fatal(err)
	}
	if differentPrevalence.MachinePrecision == nil ||
		*differentPrevalence.MachinePrecision == *balanced.MachinePrecision ||
		differentPrevalence.Fingerprint == balanced.Fingerprint {
		t.Fatalf("deployment prevalence provenance did not affect precision/receipt")
	}
}

func TestSeedOnlyCalibrationIsDiagnosticAndCannotCertifyRecall(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	observation.IsSeed = true
	machine := calibrationCorpus(ControlledMachineCorpus, "3", LabeledExample{
		ID: "machine-1", GroundTruth: Machine, Observation: observation,
	})
	policy := calibrationTestPolicy()
	policy.MinimumMachineSamples = 1
	policy.MinimumHumanSamples = 1
	report, err := EvaluateCalibration(context.Background(), classifier, policy, machine)
	if err != nil {
		t.Fatal(err)
	}
	if report.Result != "insufficient_corpus" || report.MachineSampleCount != 0 ||
		report.ControlledSeedSampleCount != 1 || report.MachineRecall != nil ||
		report.MachinePrecision != nil || report.FalseMachinePositiveRate != nil ||
		report.PerSource["fixture"].DiagnosticSamples != 1 ||
		report.PerSource["fixture"].ControlledSeedSamples != 1 {
		t.Fatalf("seed-only report overclaimed certifying evidence: %+v", report)
	}
}

func TestCalibrationLeavesPrecisionAndIntervalUndefinedWithoutPredictedMachines(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	machineObservation := validObservation()
	machineObservation.DeliveredAt = nil
	humanObservation := validObservation()
	humanObservation.DeliveredAt = nil
	report, err := EvaluateCalibration(
		context.Background(), classifier, calibrationTestPolicy(),
		calibrationCorpus(ControlledMachineCorpus, "a", LabeledExample{
			ID: "unknown-machine", GroundTruth: Machine, Observation: machineObservation,
		}),
		calibrationCorpus(LabeledHumanCorpus, "b", LabeledExample{
			ID: "unknown-human", GroundTruth: Human, Observation: humanObservation,
		}),
	)
	if err != nil {
		t.Fatal(err)
	}
	if report.MachineRecall == nil || *report.MachineRecall != 0 ||
		report.FalseMachinePositiveRate == nil || *report.FalseMachinePositiveRate != 0 ||
		report.MachinePrecision != nil || report.MachinePrecisionInterval != nil ||
		report.Result != "insufficient_corpus" {
		t.Fatalf("undefined precision acquired a point or interval: %+v", report)
	}
	if err := validateCalibrationReportIntegrity(report); err != nil {
		t.Fatalf("undefined-precision report failed integrity validation: %v", err)
	}
}

func TestCalibrationRejectsDuplicateSamplingUnitsAcrossCorpora(t *testing.T) {
	classifier := calibrationMachineClassifier(t)
	observation := calibrationMachineObservation()
	unit := repeat("a", 64)
	first := calibrationCorpus(ControlledMachineCorpus, "1", LabeledExample{
		ID: "machine-first", SamplingUnitHash: unit, GroundTruth: Machine,
		Observation: observation,
	})
	second := calibrationCorpus(ControlledMachineCorpus, "2", LabeledExample{
		ID: "machine-second", SamplingUnitHash: unit, GroundTruth: Machine,
		Observation: observation,
	})
	_, err := EvaluateCalibration(context.Background(), classifier, calibrationTestPolicy(), first, second)
	if err == nil || !strings.Contains(err.Error(), "duplicate calibration sampling-unit hash") {
		t.Fatalf("duplicate sampling-unit err=%v", err)
	}
}

func TestCorrelatedHumansRemainDiagnostic(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	dwell := int64(30_000)
	observation.DwellMilliseconds = &dwell
	correlated := calibrationCorpus(CorrelatedHumanCorpus, "4", LabeledExample{
		ID: "conversion-1", Provider: "gmail", GroundTruth: Human,
		Observation: observation,
	})
	policy := calibrationTestPolicy()
	policy.MinimumMachineSamples = 1
	policy.MinimumHumanSamples = 1
	report, err := EvaluateCalibration(context.Background(), classifier, policy, correlated)
	if err != nil {
		t.Fatal(err)
	}
	if report.HumanSampleCount != 0 || report.MachinePrecision != nil ||
		report.PerSource["gmail"].Human != 1 ||
		report.PerSource["gmail"].CertifyingSamples != 0 ||
		report.PerSource["gmail"].DiagnosticSamples != 1 ||
		report.PerSource["gmail"].DiagnosticConfusion.HumanAsHuman != 1 ||
		report.CorrelatedCorpusManifestHash == "" {
		t.Fatalf("correlated corpus was promoted into certified human negatives: %+v", report)
	}

	other := calibrationCorpus(CorrelatedHumanCorpus, "5", LabeledExample{
		ID: "conversion-1", Provider: "gmail", GroundTruth: Human,
		Observation: observation,
	})
	otherReport, err := EvaluateCalibration(context.Background(), classifier, policy, other)
	if err != nil {
		t.Fatal(err)
	}
	if otherReport.CorrelatedCorpusManifestHash == report.CorrelatedCorpusManifestHash ||
		otherReport.Fingerprint == report.Fingerprint {
		t.Fatalf("distinct correlated evidence collided: first=%+v second=%+v", report, otherReport)
	}
}

func TestCalibrationStopsUnboundedOrMisbehavingCorpusStreams(t *testing.T) {
	classifier := mustClassifier(t, DefaultConfig())
	observation := validObservation()
	observation.IsSeed = true
	corpus := ignoringVisitorErrorCorpus{
		manifest: CorpusManifest{
			Name: "misbehaving", Kind: ControlledMachineCorpus, Version: "corpus.v1",
			ManifestHash: repeat("9", 64), Provider: "fixture", SamplingUnit: "event", SampleCount: 1,
		},
		example: LabeledExample{
			ID: "first-example", SamplingUnitHash: repeat("9", 64), GroundTruth: Machine, Observation: observation,
		},
	}
	_, err := EvaluateCalibration(context.Background(), classifier, calibrationTestPolicy(), corpus)
	if err == nil || !strings.Contains(err.Error(), "sample-bound error") {
		t.Fatalf("misbehaving corpus err=%v, want bounded rejection", err)
	}

	tooMany := make([]CalibrationCorpus, maxCalibrationCorpora+1)
	for index := range tooMany {
		tooMany[index] = corpus
	}
	_, err = EvaluateCalibration(context.Background(), classifier, calibrationTestPolicy(), tooMany...)
	if err == nil || !strings.Contains(err.Error(), "exceeds 32 corpora") {
		t.Fatalf("too many corpora err=%v", err)
	}
}
