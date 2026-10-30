// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	ReachCutoverApprovalV1 = "postwave.engagement-reach-cutover-approval.v1"

	ReachUnavailableCode    = "human_engaged_reach_unavailable"
	ReachUnavailableMessage = "Classifier-based engagement reach is unavailable until a passing dual-corpus calibration receipt and a separate cutover approval are present."

	minimumReachMachineSamples           int64   = 1000
	minimumReachHumanSamples             int64   = 1000
	minimumReachMachineRecall            float64 = 0.95
	minimumReachMachinePrecision         float64 = 0.99
	maximumReachFalseMachinePositiveRate float64 = 0.01
	maxReachCutoverApprovals                     = 256
)

// ReachClassifierApproval is one exact classifier identity whose F01
// calibration and separate F12 cutover review both passed. Approval metadata
// stays server-side; customer reports carry the classifier identity, not the
// operator who approved it or a pointer into an internal review system.
type ReachClassifierApproval struct {
	ApprovalID          string
	CalibrationReportID string
	ClassifierVersion   string
	MethodologyVersion  string
	RegistryVersion     string
	ConfigurationHash   string
	ApprovedAt          time.Time
}

// ReachReleaseStatus is authoritative only when returned by a durable
// ReachReleaseGate. An empty value is deliberately unavailable.
type ReachReleaseStatus struct {
	Approved []ReachClassifierApproval
}

func (status ReachReleaseStatus) Available() bool {
	return len(status.Approved) > 0
}

// AuthorizesCoverage prevents a global approval from retrospectively turning
// a shadow or unclassified historical window into a customer claim. Every
// contributing classifier identity must have its own calibration+approval and
// every contributing verdict must be non-shadow.
func (status ReachReleaseStatus) AuthorizesCoverage(coverage []ClassifierVersionCoverage) bool {
	if len(coverage) == 0 || len(status.Approved) == 0 {
		return false
	}
	approved := make(map[reachClassifierIdentity]struct{}, len(status.Approved))
	for _, item := range status.Approved {
		identity := reachClassifierIdentity{
			classifierVersion:  item.ClassifierVersion,
			methodologyVersion: item.MethodologyVersion,
			registryVersion:    item.RegistryVersion,
			configurationHash:  item.ConfigurationHash,
		}
		if !identity.valid() {
			return false
		}
		approved[identity] = struct{}{}
	}
	for _, item := range coverage {
		if item.Unclassified || item.ShadowMode || item.EventCount <= 0 {
			return false
		}
		identity := reachClassifierIdentity{
			classifierVersion:  item.ClassifierVersion,
			methodologyVersion: item.MethodologyVersion,
			registryVersion:    item.RegistryVersion,
			configurationHash:  item.ConfigurationHash,
		}
		if _, ok := approved[identity]; !ok {
			return false
		}
	}
	return true
}

type reachClassifierIdentity struct {
	classifierVersion  string
	methodologyVersion string
	registryVersion    string
	configurationHash  string
}

func (identity reachClassifierIdentity) valid() bool {
	return versionPattern.MatchString(identity.classifierVersion) &&
		versionPattern.MatchString(identity.methodologyVersion) &&
		versionPattern.MatchString(identity.registryVersion) &&
		hashPattern.MatchString(identity.configurationHash)
}

// ReachReleaseGate is the narrow F01-to-F12 release boundary. It is separate
// from ReportReader so a reporting fake cannot accidentally make itself
// authoritative merely by returning counts.
type ReachReleaseGate interface {
	HumanEngagedReachRelease(context.Context) (ReachReleaseStatus, error)
}

// HumanEngagedReachRelease evaluates durable evidence on every read. There is
// intentionally no environment-variable bypass: configuration can enable a
// worker, but it cannot manufacture calibration or operator approval.
func (repo *Repo) HumanEngagedReachRelease(ctx context.Context) (ReachReleaseStatus, error) {
	if repo == nil || repo.Pool == nil {
		return ReachReleaseStatus{}, fmt.Errorf("%w: reach release database pool is required", ErrInvalidInput)
	}
	tx, err := db.WithWorkerScope(ctx, repo.Pool)
	if err != nil {
		return ReachReleaseStatus{}, fmt.Errorf("open reach release evidence transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		"SELECT set_config('app.engagement_classifier_worker', 'true', true)"); err != nil {
		return ReachReleaseStatus{}, fmt.Errorf("bind reach release evidence reader: %w", err)
	}

	rows, err := tx.Query(ctx, `
SELECT approval.id::text,
       calibration.id::text,
       calibration.classifier_version,
       calibration.methodology_version,
       calibration.registry_version,
       calibration.configuration_hash,
       approval.approved_at
  FROM engagement_classifier_reach_cutover_approvals AS approval
  JOIN engagement_classifier_calibration_reports AS calibration
    ON calibration.id = approval.calibration_report_id
   AND calibration.report_fingerprint = approval.calibration_report_fingerprint
   AND calibration.classifier_version = approval.classifier_version
   AND calibration.methodology_version = approval.methodology_version
   AND calibration.registry_version = approval.registry_version
   AND calibration.configuration_hash = approval.configuration_hash
  JOIN engagement_machine_registry_versions AS registry
    ON registry.registry_version = calibration.registry_version
   AND registry.provenance_state = 'sealed_snapshot'
 WHERE approval.approval_schema_version = $1
   AND approval.approved_at >= calibration.recorded_at
   AND calibration.report_schema_version = $2
   AND calibration.result = 'pass'
   AND calibration.machine_sample_count >= $3
   AND calibration.human_sample_count >= $4
   AND calibration.machine_recall_lower_bound >= $5
   AND calibration.machine_precision_lower_bound >= $6
   AND calibration.false_machine_positive_rate_upper_bound <= $7
 ORDER BY approval.approved_at DESC, approval.id DESC
 LIMIT $8`, ReachCutoverApprovalV1, CalibrationReportV2,
		minimumReachMachineSamples, minimumReachHumanSamples,
		minimumReachMachineRecall, minimumReachMachinePrecision,
		maximumReachFalseMachinePositiveRate, maxReachCutoverApprovals+1)
	if err != nil {
		return ReachReleaseStatus{}, fmt.Errorf("read reach release evidence: %w", err)
	}
	defer rows.Close()

	status := ReachReleaseStatus{Approved: []ReachClassifierApproval{}}
	for rows.Next() {
		var item ReachClassifierApproval
		if err := rows.Scan(
			&item.ApprovalID,
			&item.CalibrationReportID,
			&item.ClassifierVersion,
			&item.MethodologyVersion,
			&item.RegistryVersion,
			&item.ConfigurationHash,
			&item.ApprovedAt,
		); err != nil {
			return ReachReleaseStatus{}, fmt.Errorf("scan reach release evidence: %w", err)
		}
		if len(status.Approved) == maxReachCutoverApprovals {
			return ReachReleaseStatus{}, fmt.Errorf("reach release evidence exceeds %d approvals", maxReachCutoverApprovals)
		}
		if strings.TrimSpace(item.ApprovalID) == "" ||
			strings.TrimSpace(item.CalibrationReportID) == "" ||
			!(reachClassifierIdentity{
				classifierVersion:  item.ClassifierVersion,
				methodologyVersion: item.MethodologyVersion,
				registryVersion:    item.RegistryVersion,
				configurationHash:  item.ConfigurationHash,
			}).valid() || item.ApprovedAt.IsZero() {
			return ReachReleaseStatus{}, fmt.Errorf("reach release evidence contains an invalid approval identity")
		}
		item.ApprovedAt = item.ApprovedAt.UTC()
		status.Approved = append(status.Approved, item)
	}
	if err := rows.Err(); err != nil {
		return ReachReleaseStatus{}, fmt.Errorf("iterate reach release evidence: %w", err)
	}
	return status, nil
}

// This assertion catches an accidental signature change before it reaches the
// HTTP composition, where a nil/mismatched gate would correctly but silently
// leave F12 unavailable.
var _ ReachReleaseGate = (*Repo)(nil)
