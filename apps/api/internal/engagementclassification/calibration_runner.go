// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type CalibrationRunOptions struct {
	Config  Config
	Policy  CalibrationPolicy
	Persist bool
}

// RunCalibration evaluates immutable corpora against one exact published
// registry revision. Persist=true writes the hash-addressed append-only v2
// receipt; replaying the same evidence and policy returns the same receipt.
func RunCalibration(
	ctx context.Context,
	pool *db.Pool,
	options CalibrationRunOptions,
	corpora ...CalibrationCorpus,
) (CalibrationReport, error) {
	if pool == nil {
		return CalibrationReport{}, fmt.Errorf("%w: calibration database pool is required", ErrInvalidInput)
	}
	if err := options.Config.Validate(); err != nil {
		return CalibrationReport{}, err
	}
	if err := validateCalibrationPolicy(options.Policy); err != nil {
		return CalibrationReport{}, err
	}
	if len(corpora) == 0 {
		return CalibrationReport{}, fmt.Errorf("%w: at least one calibration corpus is required", ErrInvalidInput)
	}
	repo := &Repo{Pool: pool}
	registry, err := repo.LoadRegistry(ctx, options.Config.RegistryVersion)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("load calibration registry: %w", err)
	}
	if len(registry) == 0 {
		return CalibrationReport{}, fmt.Errorf("%w: calibration registry %q is empty", ErrInvalidInput, options.Config.RegistryVersion)
	}
	classifier, err := NewClassifier(options.Config, registry)
	if err != nil {
		return CalibrationReport{}, fmt.Errorf("compile calibration classifier: %w", err)
	}
	report, err := EvaluateCalibration(ctx, classifier, options.Policy, corpora...)
	if err != nil {
		return CalibrationReport{}, err
	}
	if !options.Persist {
		return report, nil
	}
	report, err = repo.RecordCalibrationReport(ctx, classifier, report)
	if err != nil {
		return CalibrationReport{}, err
	}
	return report, nil
}
