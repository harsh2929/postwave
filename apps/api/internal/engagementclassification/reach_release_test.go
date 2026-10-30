// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestReachReleaseStatusRequiresApprovedNonShadowCoverage(t *testing.T) {
	identity := ReachClassifierApproval{
		ApprovalID: "approval", CalibrationReportID: "calibration",
		ClassifierVersion: "classifier-v2", MethodologyVersion: "method-v2",
		RegistryVersion: "registry-v2", ConfigurationHash: strings.Repeat("a", 64),
		ApprovedAt: time.Now().UTC(),
	}
	status := ReachReleaseStatus{Approved: []ReachClassifierApproval{identity}}
	coverage := ClassifierVersionCoverage{
		ClassifierVersion:  identity.ClassifierVersion,
		MethodologyVersion: identity.MethodologyVersion,
		RegistryVersion:    identity.RegistryVersion,
		ConfigurationHash:  identity.ConfigurationHash,
		EventCount:         1,
	}
	if !status.Available() || !status.AuthorizesCoverage([]ClassifierVersionCoverage{coverage}) {
		t.Fatal("exact approved non-shadow classifier coverage was not authorized")
	}

	for name, mutate := range map[string]func(*ClassifierVersionCoverage){
		"shadow":       func(item *ClassifierVersionCoverage) { item.ShadowMode = true },
		"unclassified": func(item *ClassifierVersionCoverage) { item.Unclassified = true },
		"empty count":  func(item *ClassifierVersionCoverage) { item.EventCount = 0 },
		"other config": func(item *ClassifierVersionCoverage) { item.ConfigurationHash = strings.Repeat("b", 64) },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := coverage
			mutate(&candidate)
			if status.AuthorizesCoverage([]ClassifierVersionCoverage{candidate}) {
				t.Fatalf("%s coverage bypassed the release gate", name)
			}
		})
	}
	if status.AuthorizesCoverage(nil) || (ReachReleaseStatus{}).Available() {
		t.Fatal("missing approval or missing provenance became available")
	}
}

func TestHumanEngagedReachReleaseRequiresImmutableCalibrationAndApproval_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := classifierDBPools(t, ctx)

	runID := strings.ReplaceAll(uuid.NewString(), "-", "")
	config := DefaultConfig()
	config.MethodologyVersion = "postwave.engagement-methodology.test." + runID[:16]
	classifier, err := NewClassifier(config, []RegistryEntry{registryEntry(
		"R_RELEASE_GATE_MACHINE_UA", MatchUASubstring, "ReleaseGateMachineAgent",
		SubtypeLinkChecker, 1,
	)})
	if err != nil {
		t.Fatalf("build release-gate classifier: %v", err)
	}
	machineObservation := validObservation()
	machineObservation.UserAgent = "ReleaseGateMachineAgent/1.0"
	humanObservation := validObservation()
	dwell := int64(30_000)
	humanObservation.DwellMilliseconds = &dwell
	machineExamples := make([]LabeledExample, 0, minimumReachMachineSamples)
	humanExamples := make([]LabeledExample, 0, minimumReachHumanSamples)
	for index := 0; index < int(minimumReachMachineSamples); index++ {
		machineExamples = append(machineExamples, LabeledExample{
			ID: fmt.Sprintf("release-%s-machine-%d", runID, index), Provider: "fixture",
			GroundTruth: Machine, Observation: machineObservation,
		})
		humanExamples = append(humanExamples, LabeledExample{
			ID: fmt.Sprintf("release-%s-human-%d", runID, index), Provider: "fixture",
			GroundTruth: Human, Observation: humanObservation,
		})
	}
	machineCorpus := calibrationCorpus(ControlledMachineCorpus, "a", machineExamples...)
	humanCorpus := calibrationCorpus(LabeledHumanCorpus, "b", humanExamples...)
	machineCorpus.manifest.ManifestHash = reachReleaseTestHash("machine-" + runID)
	humanCorpus.manifest.ManifestHash = reachReleaseTestHash("human-" + runID)
	policy := calibrationTestPolicy()
	policy.PrevalenceEvidenceManifestHash = reachReleaseTestHash("prevalence-" + runID)
	report, err := EvaluateCalibration(ctx, classifier, policy, machineCorpus, humanCorpus)
	if err != nil || report.Result != "pass" {
		t.Fatalf("evaluate release calibration result=%q err=%v", report.Result, err)
	}
	repo := &Repo{Pool: (*db.Pool)(app)}
	report, err = repo.RecordCalibrationReport(ctx, classifier, report)
	if err != nil {
		t.Fatalf("persist release calibration: %v", err)
	}
	coverage := []ClassifierVersionCoverage{{
		ClassifierVersion:  report.ClassifierVersion,
		MethodologyVersion: report.MethodologyVersion,
		RegistryVersion:    report.RegistryVersion,
		ConfigurationHash:  report.ConfigurationHash,
		EventCount:         1,
	}}

	before, err := repo.HumanEngagedReachRelease(ctx)
	if err != nil {
		t.Fatalf("evaluate release before approval: %v", err)
	}
	if before.AuthorizesCoverage(coverage) {
		t.Fatal("passing calibration alone authorized F12 without separate approval")
	}

	appTx, err := db.WithWorkerScope(ctx, (*db.Pool)(app))
	if err != nil {
		t.Fatalf("open application worker transaction: %v", err)
	}
	defer func() { _ = appTx.Rollback(ctx) }()
	if _, err := appTx.Exec(ctx,
		"SELECT set_config('app.engagement_classifier_worker', 'true', true)"); err != nil {
		t.Fatalf("bind application classifier worker: %v", err)
	}
	_, appInsertErr := appTx.Exec(ctx, `
INSERT INTO engagement_classifier_reach_cutover_approvals (
    approval_schema_version, calibration_report_id,
    calibration_report_fingerprint, classifier_version,
    methodology_version, registry_version, configuration_hash,
    approved_by, approval_reason, review_evidence_sha256
) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)`,
		ReachCutoverApprovalV1, report.ID, report.Fingerprint,
		report.ClassifierVersion, report.MethodologyVersion,
		report.RegistryVersion, report.ConfigurationHash,
		"test:application", "Application processes must not approve their own release.",
		reachReleaseTestHash("forbidden-"+runID))
	if state := classifierSQLState(appInsertErr); state != "42501" {
		t.Fatalf("application approval insert error=%v state=%q, want 42501", appInsertErr, state)
	}

	var approvalID string
	if err := admin.QueryRow(ctx, `
INSERT INTO engagement_classifier_reach_cutover_approvals (
    approval_schema_version, calibration_report_id,
    calibration_report_fingerprint, classifier_version,
    methodology_version, registry_version, configuration_hash,
    approved_by, approval_reason, review_evidence_sha256
) VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING id::text`, ReachCutoverApprovalV1, report.ID, report.Fingerprint,
		report.ClassifierVersion, report.MethodologyVersion,
		report.RegistryVersion, report.ConfigurationHash,
		"release-review:test", "Independent test cutover review approved this exact classifier identity.",
		reachReleaseTestHash("review-"+runID)).Scan(&approvalID); err != nil {
		t.Fatalf("insert operator cutover approval: %v", err)
	}

	after, err := repo.HumanEngagedReachRelease(ctx)
	if err != nil {
		t.Fatalf("evaluate release after approval: %v", err)
	}
	if !after.AuthorizesCoverage(coverage) {
		t.Fatalf("calibration+approval did not authorize exact coverage: %+v", after)
	}
	if _, err := admin.Exec(ctx, `
UPDATE engagement_classifier_reach_cutover_approvals
   SET approval_reason = 'Mutated approval reason must be rejected.'
 WHERE id = $1::uuid`, approvalID); classifierSQLState(err) != "55000" {
		t.Fatalf("approval mutation error=%v state=%q, want 55000", err, classifierSQLState(err))
	}
}

func reachReleaseTestHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
